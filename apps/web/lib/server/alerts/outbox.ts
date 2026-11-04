/**
 * Alert email through the notification outbox (_specs/v2-m1-elder.md §6): plan the recipients,
 * write the outbox rows with the alert (one transaction), then drain them. Postgres via
 * @neo/db when DATABASE_URL is set, else the memory twins in memory-alerts.ts.
 *
 * Everything an email says is templated (renderAlertEmail), never model-written.
 */
import { ArtifactDecryptError, effectivePolicy, logger } from "@neo/core";
import {
  claimOutboxRows,
  openDecisionToken,
  sealDecisionToken,
  getChildRequest,
  getChildRequestByAlert,
  isRequestAlertKind,
  createAlert,
  createAlertWithOutbox,
  enqueueOutboxForAlert,
  getAlert,
  getMemberContact,
  getProtectionLayers,
  listAlertOwners,
  listMemberRecords,
  listMembers,
  listPendingOutboxTenants,
  markOutboxFailed,
  markOutboxSent,
  outboxDestination,
  OUTBOX_MAX_ATTEMPTS,
  settleAlertEmail,
  tenantScoped,
  type AlertEnqueuePlan,
  type AlertRow,
  type ChildRequestRow,
  type CreateAlertInput,
  type HouseholdMember,
  type OutboxRow,
  type OutboxRowInput,
  type ProtectionMode,
} from "@neo/db";
import type { Severity } from "@neo/verdict";
import { incidentChatApplies, incidentChatPath } from "@/lib/alert-types";
import { eveChatEnabled, inboundEnv } from "@/lib/env";
import { getDb } from "../db";
import { renderAlertCapEmail, renderAlertEmail } from "../email/alert-email";
import { renderChildRequestEmail } from "../email/child-request-email";
import { getMailer, MailerHttpError, type Mailer } from "../email/resend";
import {
  memoryAlertOwners,
  memoryClaimOutbox,
  memoryCreateAlert,
  memoryCreateAlertWithOutbox,
  memoryEnqueueOutboxForAlert,
  memoryGetAlert,
  memoryMarkOutboxFailed,
  memoryMarkOutboxSent,
  memoryPendingOutboxTenants,
  memorySettleAlertEmail,
} from "../memory-alerts";
import { memoryContactMembers, memoryProtection } from "../memory-members";
import { memoryListMembers } from "../memory-state";
import { getDevice } from "../devices";
import {
  ALERT_EMAIL_DAILY_CAP,
  protectedMode,
  recipientKeyPart,
  resendKeyFor,
  resolveAlertRecipients,
  resolveRequestRecipients,
  type AlertRecipient,
  type RecipientMember,
} from "./recipients";
import { deviceLabel } from "./templates";

const DRAIN_BATCH = 50;

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

// ─── Planning ──────────────────────────────────────────────────────

/** The child request an alert is about; `token` is the raw email-link token (only known when the request was just opened). */
export interface AlertRequestRef {
  id: string;
  token?: string;
}

interface PlanSubject {
  /** `child_request` and `app_approval` alerts go to the request's recipients, not the owners' thresholds. */
  kind?: string;
  request?: AlertRequestRef;
  severity: AlertRow["severity"];
  memberId: string | null | undefined;
  subjectUserId: string | null;
  deviceId: string | null | undefined;
}

interface RecipientContext {
  recipients: AlertRecipient[];
  subjectName: string | null;
  deviceName: string | null;
}

function memoryMembersFor(tenantId: string): RecipientMember[] {
  const accounts = memoryListMembers(tenantId).map((m): RecipientMember => {
    const p = memoryProtection(tenantId, m.userId);
    return { id: p.memberId, userId: m.userId, displayName: m.name || m.email || "A member", mode: p.mode, helperMemberIds: p.helperMemberIds, email: m.email, contact: null };
  });
  const contacts = memoryContactMembers(tenantId).map(
    (c): RecipientMember => ({ id: c.id, userId: null, displayName: c.displayName, mode: c.mode ?? "standard", helperMemberIds: c.helperMemberIds ?? [], email: null, contact: c.contact || null }),
  );
  return [...accounts, ...contacts];
}

async function databaseMembersFor(db: NonNullable<ReturnType<typeof getDb>>, tenantId: string): Promise<{ members: RecipientMember[]; accounts: HouseholdMember[] }> {
  const tdb = tenantScoped(db, tenantId);
  const [rows, accounts] = await Promise.all([listMemberRecords(tdb), listMembers(db, tenantId)]);
  const emailByUser = new Map(accounts.map((a) => [a.userId, a.email]));
  return {
    accounts,
    members: rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      displayName: r.displayName,
      mode: r.mode,
      helperMemberIds: r.helperMemberIds,
      email: r.userId ? (emailByUser.get(r.userId) ?? null) : null,
      contact: null,
    })),
  };
}

async function loadRecipientContext(tenantId: string, q: PlanSubject): Promise<RecipientContext> {
  const db = getDb();
  const owners = db ? await listAlertOwners(db, tenantId) : memoryAlertOwners(tenantId);
  const members = db ? (await databaseMembersFor(db, tenantId)).members : memoryMembersFor(tenantId);
  const subject = (q.memberId ? members.find((m) => m.id === q.memberId) : undefined) ?? (q.subjectUserId ? members.find((m) => m.userId === q.subjectUserId) : undefined) ?? null;

  let helpersNotifyAt: Severity | undefined;
  let childRequestsTo: "owners" | "helpers" = "owners";
  if (subject && protectedMode(subject.mode)) {
    if (db) {
      const tdb = tenantScoped(db, tenantId);
      const layers = subject.userId
        ? await getProtectionLayers(tdb, { userId: subject.userId })
        : subject.id
          ? await getProtectionLayers(tdb, { memberId: subject.id })
          : { mode: subject.mode as ProtectionMode };
      const effective = effectivePolicy(layers as Parameters<typeof effectivePolicy>[0]);
      helpersNotifyAt = effective.notify?.helpersNotifyAt;
      childRequestsTo = effective.notify?.childRequestsTo ?? "owners";
      // Decrypt the contact only for helpers who need it.
      for (const id of subject.helperMemberIds) {
        const h = members.find((m) => m.id === id);
        if (!h || h.email) continue;
        try {
          h.contact = await getMemberContact(tdb, id);
        } catch (err) {
          logger.error("Helper contact unreadable", "alerts", { tenantId, errorMessage: errText(err) });
        }
      }
    } else {
      const effective = effectivePolicy({ mode: subject.mode });
      helpersNotifyAt = effective.notify?.helpersNotifyAt;
      childRequestsTo = effective.notify?.childRequestsTo ?? "owners";
    }
  }

  let deviceName: string | null = null;
  if (q.deviceId) {
    try {
      const d = await getDevice(tenantId, q.deviceId);
      deviceName = d ? deviceLabel(d.name) : null;
    } catch {
      deviceName = null;
    }
  }

  const recipients = isRequestAlertKind(q.kind)
    ? resolveRequestRecipients({ owners, members, subject, target: childRequestsTo })
    : resolveAlertRecipients({ severity: q.severity, owners, members, subject, helpersNotifyAt });
  return {
    recipients,
    subjectName: subject?.displayName ?? null,
    deviceName,
  };
}

/** The enqueue plan for one alert. With no mailer the plan has no rows, so the alert is `skipped`. */
async function planFor(tenantId: string, q: PlanSubject): Promise<AlertEnqueuePlan> {
  const ctx = await loadRecipientContext(tenantId, q);
  const mailer = getMailer();
  const toRow = (alertId: string, r: AlertRecipient): OutboxRowInput => ({
    idempotencyKey: `alert:${alertId}:${recipientKeyPart(r)}`,
    address: r.address,
    template: "alert",
    recipientMemberId: r.memberId,
    recipientUserId: r.userId,
    payload: {
      recipientKind: r.kind,
      hasAccount: r.userId !== null,
      resendKey: resendKeyFor(alertId, r),
      subjectName: ctx.subjectName,
      deviceName: ctx.deviceName,
      ...(q.request ? { requestId: q.request.id } : {}),
      // Only an owner with an account can follow Approve/Deny links. The raw token is sealed with the
      // same envelope as the destination (bound to this row's key), never stored in the clear.
      ...(q.request?.token && r.kind === "owner" && r.userId
        ? { decisionTokenSealed: sealDecisionToken(tenantId, `alert:${alertId}:${recipientKeyPart(r)}`, q.request.token) }
        : {}),
    },
  });
  return {
    cap: ALERT_EMAIL_DAILY_CAP,
    rows: (alert) => (mailer ? ctx.recipients.map((r) => toRow(alert.id, r)) : []),
    capRows: (_alert, dayStart) => {
      const date = dayStart.toISOString().slice(0, 10);
      return ctx.recipients
        .filter((r) => r.kind === "owner" && r.userId)
        .map((r) => {
          const key = `alert-cap:${tenantId}:${date}:${r.userId}`;
          return { idempotencyKey: key, address: r.address, template: "alert_cap" as const, recipientMemberId: r.memberId, recipientUserId: r.userId, payload: { resendKey: key } };
        });
    },
  };
}

// ─── Enqueue ───────────────────────────────────────────────────────

/**
 * Insert the alert (deduplicated) and its outbox rows in one transaction. `enqueued` is how
 * many rows need draining. If the recipient lookup fails the alert is still created, `pending`
 * with no rows, and the `alert-created` function enqueues it later.
 */
export async function createAlertAndEnqueue(input: CreateAlertInput, request?: AlertRequestRef): Promise<{ alert: AlertRow; enqueued: number } | null> {
  const db = getDb();
  let plan: AlertEnqueuePlan | null = null;
  try {
    plan = await planFor(input.tenantId, {
      kind: input.kind,
      ...(request ? { request } : {}),
      severity: input.severity,
      memberId: input.memberId,
      subjectUserId: input.subjectUserId,
      deviceId: input.deviceId,
    });
  } catch (err) {
    logger.error("Alert recipient lookup failed; enqueue deferred", "alerts", { tenantId: input.tenantId, errorMessage: errText(err) });
  }
  if (!plan) {
    const alert = db ? await createAlert(db, input) : memoryCreateAlert(input);
    return alert ? { alert, enqueued: 1 } : null; // 1: the event still goes out so the legacy path enqueues it
  }
  const r = db ? await createAlertWithOutbox(db, input, plan) : memoryCreateAlertWithOutbox(input, plan);
  return r ? { alert: r.alert, enqueued: r.enqueued } : null;
}

/** Enqueue rows for a `pending` alert that has none (raised before the outbox, or a deferred enqueue). */
export async function enqueueIfLegacy(tenantId: string, alertId: string): Promise<number> {
  const db = getDb();
  const alert = db ? await getAlert(db, tenantId, alertId) : memoryGetAlert(tenantId, alertId);
  if (!alert || alert.emailStatus !== "pending") return 0;
  // A request alert enqueued late has lost its raw token (only the hash is stored): its email links to the console instead.
  let request: AlertRequestRef | undefined;
  if (db && isRequestAlertKind(alert.kind)) {
    const row = await getChildRequestByAlert(tenantScoped(db, tenantId), alert.id);
    if (row) request = { id: row.id };
  }
  const plan = await planFor(tenantId, {
    kind: alert.kind,
    ...(request ? { request } : {}),
    severity: alert.severity,
    memberId: alert.memberId,
    subjectUserId: alert.subjectUserId,
    deviceId: alert.deviceId,
  });
  const r = db ? await enqueueOutboxForAlert(db, tenantId, alertId, plan) : memoryEnqueueOutboxForAlert(tenantId, alertId, plan);
  return r.enqueued;
}

// ─── Drain ─────────────────────────────────────────────────────────

export interface OutboxDrainDeps {
  claim(tenantId: string, now: Date, limit: number): Promise<OutboxRow[]>;
  markSent(tenantId: string, id: string, providerId: string, now: Date): Promise<void>;
  markFailed(tenantId: string, id: string, error: string, permanent: boolean): Promise<void>;
  settle(tenantId: string, alertId: string, now: Date): Promise<void>;
  getAlert(tenantId: string, id: string): Promise<AlertRow | undefined>;
  /** A child request, for the request emails (the child's reason is quoted from here, never copied into the outbox). */
  getChildRequest?(tenantId: string, id: string): Promise<ChildRequestRow | undefined>;
  pendingTenants(): Promise<string[]>;
  mailer: Mailer | null;
  appUrl: string;
}

/** The read-only side of the drain: which households have rows due. Never claims or leases a row (the shadow sweep uses only this). */
export function createOutboxReadPorts(): Pick<OutboxDrainDeps, "pendingTenants"> {
  const db = getDb();
  return { pendingTenants: async () => (db ? listPendingOutboxTenants(db) : memoryPendingOutboxTenants()) };
}

export function createOutboxDrainDeps(): OutboxDrainDeps {
  const db = getDb();
  return {
    claim: async (t, now, limit) => (db ? claimOutboxRows(db, t, { now, limit }) : memoryClaimOutbox(t, now, limit)),
    markSent: async (t, id, providerId, now) => (db ? markOutboxSent(db, t, id, providerId, now) : memoryMarkOutboxSent(t, id, providerId, now)),
    markFailed: async (t, id, error, permanent) => (db ? markOutboxFailed(db, t, id, error, permanent) : memoryMarkOutboxFailed(t, id, error, permanent)),
    settle: async (t, alertId, now) => {
      if (db) await settleAlertEmail(db, t, alertId, now);
      else memorySettleAlertEmail(t, alertId, now);
    },
    getAlert: async (t, id) => (db ? getAlert(db, t, id) : memoryGetAlert(t, id)),
    getChildRequest: async (t, id) => (db ? getChildRequest(tenantScoped(db, t), id) : undefined),
    ...createOutboxReadPorts(),
    mailer: getMailer(),
    appUrl: inboundEnv().APP_URL,
  };
}

export interface DrainResult {
  claimed: number;
  sent: number;
  /** Failed but will be retried (attempts left). */
  retry: number;
  /** Failed for good (permanent error or attempts used up). */
  gaveUp: number;
}

class PermanentSendError extends Error {}

/** A 4xx from Resend (other than timeout / rate limit) will not succeed on retry; neither will an unreadable destination. */
function isPermanent(err: unknown): boolean {
  if (err instanceof PermanentSendError || err instanceof ArtifactDecryptError) return true;
  if (err instanceof MailerHttpError) return err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;
  return false;
}

/** Where an alert email sends the reader. With NEO_EVE_CHAT, incidents open the eve incident chat. */
export function alertLink(alert: AlertRow, appUrl: string, eveChat = eveChatEnabled()): { url: string; label: string } {
  if (eveChat && incidentChatApplies(alert.kind)) return { url: `${appUrl}${incidentChatPath(alert.id)}`, label: "Ask Neo about this" };
  if (alert.kind === "breach_detected") return { url: `${appUrl}/settings/breaches`, label: "Review breach status" };
  if (alert.kind === "mailbox_forwarding") return { url: `${appUrl}/dashboard`, label: "Open the dashboard" };
  if (alert.verdictId) return { url: `${appUrl}/verdicts/${alert.verdictId}`, label: "See the check" };
  return { url: `${appUrl}/settings/household`, label: "Open household settings" };
}

async function renderRow(row: OutboxRow, deps: OutboxDrainDeps) {
  if (row.template === "alert_cap") return renderAlertCapEmail({ dashboardUrl: `${deps.appUrl}/dashboard`, cap: ALERT_EMAIL_DAILY_CAP });
  if (row.template !== "alert" || !row.alertId) throw new PermanentSendError(`unknown outbox template ${row.template}`);
  const alert = await deps.getAlert(row.tenantId, row.alertId);
  if (!alert) throw new PermanentSendError("alert no longer exists");
  const p = row.payload as { recipientKind?: string; hasAccount?: boolean; subjectName?: string | null; deviceName?: string | null; requestId?: string; decisionTokenSealed?: string };
  if (isRequestAlertKind(alert.kind) && p.requestId && deps.getChildRequest) {
    const request = await deps.getChildRequest(row.tenantId, p.requestId);
    if (request) {
      let token: string | undefined;
      if (p.decisionTokenSealed) {
        try {
          token = openDecisionToken(row.tenantId, row.idempotencyKey, p.decisionTokenSealed);
        } catch {
          token = undefined; // an unreadable token means no links, not a failed email
        }
      }
      return renderChildRequestEmail({
        appUrl: deps.appUrl,
        request,
        title: alert.title,
        body: alert.body,
        memberName: p.subjectName || "Your child",
        deviceName: p.deviceName ?? null,
        recipient: p.recipientKind === "helper" ? "helper" : "owner",
        hasAccount: p.hasAccount === true,
        ...(token ? { token } : {}),
        ...(eveChatEnabled() && incidentChatApplies(alert.kind) ? { askUrl: `${deps.appUrl}${incidentChatPath(alert.id)}` } : {}),
      });
    }
  }
  if (p.recipientKind === "helper") {
    return renderAlertEmail({
      severity: alert.severity,
      title: alert.title,
      body: alert.body,
      // A helper without an account cannot open Neo's pages.
      ...(p.hasAccount ? { link: alertLink(alert, deps.appUrl) } : {}),
      helper: { memberName: p.subjectName || "your family member", deviceName: p.deviceName ?? null },
    });
  }
  return renderAlertEmail({ severity: alert.severity, title: alert.title, body: alert.body, link: alertLink(alert, deps.appUrl) });
}

/**
 * Claim and send one household's due outbox rows. A row is sent with its stored Resend
 * idempotency key, so a crash between send and `sent_at` cannot produce a second email. A
 * send error is recorded and the lease released; the caller (Inngest) decides whether to retry.
 * `alertId` also settles that alert even when this drain claimed nothing.
 */
export async function drainOutbox(tenantId: string, deps: OutboxDrainDeps, now = new Date(), opts: { alertId?: string } = {}): Promise<DrainResult> {
  const rows = await deps.claim(tenantId, now, DRAIN_BATCH);
  const result: DrainResult = { claimed: rows.length, sent: 0, retry: 0, gaveUp: 0 };
  const settle = new Set<string>(opts.alertId ? [opts.alertId] : []);
  for (const row of rows) {
    if (row.template === "alert" && row.alertId) settle.add(row.alertId);
    let sent: { id: string } | undefined;
    try {
      if (!deps.mailer) throw new Error("no mailer configured");
      const to = outboxDestination(row);
      const email = await renderRow(row, deps);
      const resendKey = (row.payload as { resendKey?: unknown }).resendKey;
      sent = await deps.mailer.send({ to, ...email, idempotencyKey: typeof resendKey === "string" ? resendKey : `outbox:${row.id}` });
    } catch (err) {
      const permanent = isPermanent(err);
      await deps.markFailed(tenantId, row.id, errText(err), permanent);
      if (permanent || row.attempts >= OUTBOX_MAX_ATTEMPTS) result.gaveUp++;
      else result.retry++;
      continue;
    }
    await deps.markSent(tenantId, row.id, sent.id, now);
    result.sent++;
  }
  for (const id of settle) await deps.settle(tenantId, id, now);
  return result;
}

/** The cron sweep: drain every tenant with due rows. */
export async function drainPendingOutboxes(deps: OutboxDrainDeps, now = new Date()): Promise<DrainResult> {
  const total: DrainResult = { claimed: 0, sent: 0, retry: 0, gaveUp: 0 };
  for (const tenantId of await deps.pendingTenants()) {
    try {
      const r = await drainOutbox(tenantId, deps, now);
      total.claimed += r.claimed;
      total.sent += r.sent;
      total.retry += r.retry;
      total.gaveUp += r.gaveUp;
    } catch (err) {
      logger.error("Outbox drain failed for tenant", "alerts", { tenantId, errorMessage: errText(err) });
    }
  }
  return total;
}
