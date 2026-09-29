/**
 * Owner alerts (_specs/owner-alerts.md): raise, deliver, list, acknowledge.
 * Postgres via @neo/db when DATABASE_URL is set, else memory-alerts.ts.
 *
 * Raising never throws: an alert is a side effect of a check or a membership
 * change and must not break it. Delivery runs in the `alert-created` Inngest
 * function, or inline in MOCK_MODE without INNGEST_EVENT_KEY.
 */
import { hashPii, logger } from "@neo/core";
import {
  acknowledgeAlert,
  acknowledgeAllAlerts,
  countAlertEmailsSince,
  countOpenAlerts,
  createAlert,
  getAlert,
  getAlertEmailThreshold,
  InvalidCursorError,
  listAlertOwners,
  listAlerts,
  listMembers,
  markAlertEmail,
  setAlertEmailThreshold,
  type AlertListItem,
  type AlertOwner,
  type AlertRow,
  type CreateAlertInput,
  type DevicePublic,
  type HouseholdMember,
} from "@neo/db";
import type { Verdict } from "@neo/verdict";
import { inngest } from "@/inngest/client";
import type { AlertItem, AlertListResponse, AlertThreshold } from "@/lib/alert-types";
import { env, inboundEnv } from "@/lib/env";
import type { NeoSession } from "@/lib/session";
import { recordAudit } from "../audit";
import { getDb } from "../db";
import { renderAlertCapEmail, renderAlertEmail } from "../email/alert-email";
import { getMailer, type Mailer } from "../email/resend";
import {
  memoryAcknowledgeAlert,
  memoryAcknowledgeAll,
  memoryAlertOwners,
  memoryCountAlertEmailsSince,
  memoryCountOpenAlerts,
  memoryCreateAlert,
  memoryGetAlert,
  memoryGetThreshold,
  memoryListAlerts,
  memoryMarkAlertEmail,
  memorySetThreshold,
} from "../memory-alerts";
import { memoryListMembers } from "../memory-state";
import {
  type AlertText,
  deviceEnrolledAlertText,
  deviceLabel,
  deviceOfflineAlertText,
  deviceRemovedAlertText,
  displayName,
  hourBucket,
  joinedAlertText,
  leftAlertText,
  verdictAlertText,
} from "./templates";

export const ALERT_CREATED_EVENT = "neo/alert.created";
/** Alert emails per household per UTC day before the "more than usual" notice. */
export const ALERT_EMAIL_DAILY_CAP = 20;

const SEVERITY_RANK = { low: 1, medium: 2, high: 3, critical: 4 } as const;
const THRESHOLD_RANK: Record<AlertThreshold, number> = { medium: 2, high: 3, critical: 4, off: Infinity };

export function meetsThreshold(severity: AlertRow["severity"], threshold: AlertThreshold): boolean {
  return SEVERITY_RANK[severity] >= THRESHOLD_RANK[threshold];
}

export interface AlertCreatedData {
  alertId: string;
  tenantId: string;
}

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

/** The household's members (database or memory). */
export async function tenantMembers(tenantId: string): Promise<HouseholdMember[]> {
  const db = getDb();
  return db ? listMembers(db, tenantId) : memoryListMembers(tenantId);
}
const members = tenantMembers;

// ─── Raising ───────────────────────────────────────────────────────

/** Insert (deduplicated) and queue delivery. Never throws. */
export async function raiseAlert(input: CreateAlertInput): Promise<AlertRow | null> {
  try {
    const db = getDb();
    const row = db ? await createAlert(db, input) : memoryCreateAlert(input);
    if (row) await queueDelivery({ alertId: row.id, tenantId: row.tenantId });
    return row;
  } catch (err) {
    logger.error("Alert creation failed", "alerts", { tenantId: input.tenantId, errorType: input.kind, errorMessage: errText(err) });
    return null;
  }
}

async function queueDelivery(data: AlertCreatedData): Promise<void> {
  if (env().MOCK_MODE && !inboundEnv().INNGEST_EVENT_KEY) {
    await deliverAlert(data, createAlertDeliveryDeps()).catch((err) =>
      logger.error("Inline alert delivery failed", "alerts", { tenantId: data.tenantId, errorMessage: errText(err) }),
    );
    return;
  }
  try {
    await inngest.send({ name: ALERT_CREATED_EVENT, data });
  } catch (err) {
    // The alert stays `pending` and visible in the feed.
    logger.error("Inngest send failed for alert", "alerts", { tenantId: data.tenantId, errorMessage: errText(err) });
  }
}

/** A member's malicious or suspicious verdict alerts the owner. Owners' own checks never do. */
export async function alertForVerdict(input: {
  tenantId: string;
  userId: string;
  verdictId: string;
  verdict: Verdict;
  source: "chat" | "inbound" | "api";
}): Promise<void> {
  try {
    if (input.verdict.verdict !== "malicious" && input.verdict.verdict !== "suspicious") return;
    const member = (await members(input.tenantId)).find((m) => m.userId === input.userId);
    if (!member || member.role !== "member") return;
    const text = verdictAlertText(displayName(member.name, member.email), input.verdict, input.source);
    if (!text) return;
    await raiseAlert({
      tenantId: input.tenantId,
      subjectUserId: input.userId,
      kind: "member_verdict",
      ...text,
      verdictId: input.verdictId,
      dedupeKey: `verdict:${input.verdictId}`,
    });
  } catch (err) {
    logger.error("Verdict alert failed", "alerts", { tenantId: input.tenantId, userIdHash: hashPii(input.userId), errorMessage: errText(err) });
  }
}

export async function alertMemberJoined(tenantId: string, user: { userId: string; name: string | null; email: string | null }): Promise<void> {
  await raiseAlert({
    tenantId,
    subjectUserId: user.userId,
    kind: "member_joined",
    ...joinedAlertText(displayName(user.name, user.email)),
    dedupeKey: `member_joined:${user.userId}:${hourBucket()}`,
  });
}

export async function alertMemberLeft(
  tenantId: string,
  user: { userId: string; name: string | null; email: string | null },
  removed: boolean,
): Promise<void> {
  await raiseAlert({
    tenantId,
    subjectUserId: user.userId,
    kind: "member_left",
    ...leftAlertText(displayName(user.name, user.email), removed),
    dedupeKey: `member_left:${user.userId}:${hourBucket()}`,
  });
}

// ─── Devices (_specs/device-enrollment.md) ─────────────────────────

/**
 * The device's protected member when it may alert: devices protecting an owner (or
 * someone no longer in the household) never do. Never throws.
 */
async function alertableMember(device: DevicePublic): Promise<HouseholdMember | null> {
  try {
    const m = (await members(device.tenantId)).find((x) => x.userId === device.userId);
    return m && m.role === "member" ? m : null;
  } catch (err) {
    logger.error("Device alert member lookup failed", "alerts", { tenantId: device.tenantId, errorMessage: errText(err) });
    return null;
  }
}

/** `device_enrolled` (low): a member enrolled their own device through the browser sign-in. */
export async function alertDeviceEnrolled(device: DevicePublic): Promise<boolean> {
  if (device.enrollment !== "self") return false;
  const member = await alertableMember(device);
  if (!member) return false;
  const row = await raiseAlert({
    tenantId: device.tenantId,
    subjectUserId: device.userId,
    kind: "device_enrolled",
    ...deviceEnrolledAlertText(displayName(member.name, member.email), deviceLabel(device.name)),
    deviceId: device.id,
    dedupeKey: `device_enrolled:${device.id}`,
  });
  return row !== null;
}

/** `device_removed` (high): the protected member removed it, or the device unenrolled itself. */
export async function alertDeviceRemoved(device: DevicePublic, by: "member" | "device"): Promise<boolean> {
  const member = await alertableMember(device);
  if (!member) return false;
  const row = await raiseAlert({
    tenantId: device.tenantId,
    subjectUserId: device.userId,
    kind: "device_removed",
    ...deviceRemovedAlertText(displayName(member.name, member.email), deviceLabel(device.name), by),
    deviceId: device.id,
    dedupeKey: `device_removed:${device.id}`,
  });
  return row !== null;
}

/** `device_offline` (medium): no heartbeat for 48 hours. One per outage (keyed on the last check-in). */
export async function alertDeviceOffline(device: DevicePublic): Promise<boolean> {
  const member = await alertableMember(device);
  if (!member) return false;
  const since = device.lastSeenAt ?? device.createdAt;
  const row = await raiseAlert({
    tenantId: device.tenantId,
    subjectUserId: device.userId,
    kind: "device_offline",
    ...deviceOfflineAlertText(displayName(member.name, member.email), deviceLabel(device.name), device.lastSeenAt),
    deviceId: device.id,
    dedupeKey: `device_offline:${device.id}:${since.getTime()}`,
  });
  return row !== null;
}

// ─── Device signals (_specs/signals.md) ─────────────────────────────

/** Alert kinds a signal event can raise directly (everything but the membership/device-lifecycle kinds). */
export type SignalAlertKind = "scam_page" | "dangerous_site" | "remote_access" | "unwanted_software" | "permission_grant";

/**
 * Raise a device-signal alert. Dedupe `<kind>:<deviceId>:<subject>:<UTC hour>`, so the same
 * tool/domain/app on the same device alerts at most once an hour. Owners' own devices alert
 * like everyone else's (decided 2026-09-29, _specs/signals.md): no `alertableMember` gate here.
 */
export async function alertSignal(input: {
  tenantId: string;
  userId: string;
  deviceId: string;
  kind: SignalAlertKind;
  /** The domain, toolId or app name the event is about (device_signals.subject). */
  subject: string;
  verdictId?: string | null;
  text: AlertText;
  now?: Date;
}): Promise<AlertRow | null> {
  return raiseAlert({
    tenantId: input.tenantId,
    subjectUserId: input.userId,
    deviceId: input.deviceId,
    kind: input.kind,
    severity: input.text.severity,
    title: input.text.title,
    body: input.text.body,
    ...(input.verdictId ? { verdictId: input.verdictId } : {}),
    dedupeKey: `${input.kind}:${input.deviceId}:${input.subject}:${hourBucket(input.now)}`,
  });
}

/** `warning_bypassed`: dedupe `bypass:<relatesTo>` (one bump alert per dismissed warning). */
export async function alertSignalBypass(input: {
  tenantId: string;
  userId: string;
  deviceId: string;
  kind: SignalAlertKind;
  relatesTo: string;
  verdictId?: string | null;
  text: AlertText;
}): Promise<AlertRow | null> {
  return raiseAlert({
    tenantId: input.tenantId,
    subjectUserId: input.userId,
    deviceId: input.deviceId,
    kind: input.kind,
    severity: input.text.severity,
    title: input.text.title,
    body: input.text.body,
    ...(input.verdictId ? { verdictId: input.verdictId } : {}),
    dedupeKey: `bypass:${input.relatesTo}`,
  });
}

/** `scam_in_progress`: dedupe `scam_in_progress:<userId>:<30-minute bucket>`. */
export async function alertScamInProgress(input: { tenantId: string; userId: string; bucket: string; text: AlertText }): Promise<AlertRow | null> {
  return raiseAlert({
    tenantId: input.tenantId,
    subjectUserId: input.userId,
    kind: "scam_in_progress",
    severity: input.text.severity,
    title: input.text.title,
    body: input.text.body,
    dedupeKey: `scam_in_progress:${input.userId}:${input.bucket}`,
  });
}

// ─── Delivery ──────────────────────────────────────────────────────

export interface AlertDeliveryDeps {
  getAlert(tenantId: string, id: string): Promise<AlertRow | undefined>;
  owners(tenantId: string): Promise<AlertOwner[]>;
  countSentSince(tenantId: string, since: Date): Promise<number>;
  markEmail(tenantId: string, id: string, status: AlertRow["emailStatus"]): Promise<void>;
  mailer: Mailer | null;
  appUrl: string;
}

export function createAlertDeliveryDeps(): AlertDeliveryDeps {
  const db = getDb();
  return {
    getAlert: async (t, id) => (db ? getAlert(db, t, id) : memoryGetAlert(t, id)),
    owners: async (t) => (db ? listAlertOwners(db, t) : memoryAlertOwners(t)),
    countSentSince: async (t, since) => (db ? countAlertEmailsSince(db, t, since) : memoryCountAlertEmailsSince(t, since)),
    markEmail: async (t, id, status) => (db ? markAlertEmail(db, t, id, status) : memoryMarkAlertEmail(t, id, status)),
    mailer: getMailer(),
    appUrl: inboundEnv().APP_URL,
  };
}

export type DeliveryOutcome = "sent" | "skipped" | "capped" | "missing" | "already_handled";

/**
 * Email the household's owners about one alert. Idempotent: an alert that is no longer
 * `pending` is left alone, and Resend idempotency keys cover a retry mid-send. A send
 * error propagates so Inngest retries; the function's onFailure marks it `failed`.
 */
export async function deliverAlert(data: AlertCreatedData, deps: AlertDeliveryDeps, now = new Date()): Promise<DeliveryOutcome> {
  const alert = await deps.getAlert(data.tenantId, data.alertId);
  if (!alert) return "missing";
  if (alert.emailStatus !== "pending") return "already_handled";

  const recipients = (await deps.owners(data.tenantId)).filter((o) => o.email && meetsThreshold(alert.severity, o.threshold));
  if (!deps.mailer || recipients.length === 0) {
    await deps.markEmail(data.tenantId, alert.id, "skipped");
    return "skipped";
  }

  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if ((await deps.countSentSince(data.tenantId, dayStart)) >= ALERT_EMAIL_DAILY_CAP) {
    await deps.markEmail(data.tenantId, alert.id, "skipped");
    const notice = renderAlertCapEmail({ dashboardUrl: `${deps.appUrl}/dashboard`, cap: ALERT_EMAIL_DAILY_CAP });
    const date = dayStart.toISOString().slice(0, 10);
    for (const o of recipients) {
      await deps.mailer.send({ to: o.email!, ...notice, idempotencyKey: `alert-cap:${data.tenantId}:${date}:${o.userId}` });
    }
    return "capped";
  }

  const link = alert.verdictId
    ? { url: `${deps.appUrl}/verdicts/${alert.verdictId}`, label: "See the check" }
    : { url: `${deps.appUrl}/settings/household`, label: "Open household settings" };
  const email = renderAlertEmail({ severity: alert.severity, title: alert.title, body: alert.body, link });
  for (const o of recipients) {
    await deps.mailer.send({ to: o.email!, ...email, idempotencyKey: `alert:${alert.id}:${o.userId}` });
  }
  await deps.markEmail(data.tenantId, alert.id, "sent");
  return "sent";
}

// ─── Feed and settings ─────────────────────────────────────────────

function toItem(a: AlertListItem): AlertItem {
  return {
    id: a.id,
    kind: a.kind,
    severity: a.severity,
    title: a.title,
    body: a.body,
    subjectUserId: a.subjectUserId,
    subjectName: a.subjectName,
    verdictId: a.verdictId,
    createdAt: a.createdAt.toISOString(),
    acknowledgedAt: a.acknowledgedAt ? a.acknowledgedAt.toISOString() : null,
    acknowledgedByName: a.acknowledgedByName,
  };
}

export class BadCursorError extends Error {}

/** Owners see the household's alerts; members only those about themselves. */
export async function listAlertsForSession(
  session: NeoSession,
  opts: { status: "open" | "all"; cursor?: string; limit?: number },
): Promise<AlertListResponse> {
  const scope = session.role === "owner" ? {} : { subjectUserId: session.userId };
  const db = getDb();
  let page: { items: AlertListItem[]; nextCursor?: string };
  try {
    page = db
      ? await listAlerts(db, session.tenantId, { ...scope, ...opts })
      : memoryListAlerts(session.tenantId, { ...scope, ...opts });
  } catch (err) {
    if (err instanceof InvalidCursorError || (!db && err instanceof Error && err.message === "invalid cursor")) throw new BadCursorError();
    throw err;
  }
  const openCount = db ? await countOpenAlerts(db, session.tenantId, scope) : memoryCountOpenAlerts(session.tenantId, scope);
  return { items: page.items.map(toItem), nextCursor: page.nextCursor ?? null, openCount, urgentCount: await urgentAlertCount(session) };
}

/** Open high/critical alerts visible to the session (the nav dot). Zero on storage errors. */
export async function urgentAlertCount(session: NeoSession): Promise<number> {
  try {
    const scope = session.role === "owner" ? {} : { subjectUserId: session.userId };
    const severities = ["high", "critical"] as const;
    const db = getDb();
    return db
      ? await countOpenAlerts(db, session.tenantId, { ...scope, severities })
      : memoryCountOpenAlerts(session.tenantId, { ...scope, severities });
  } catch {
    return 0;
  }
}

export async function acknowledge(session: NeoSession, id: string): Promise<AlertItem | undefined> {
  const db = getDb();
  const row = db ? await acknowledgeAlert(db, session.tenantId, id, session.userId) : memoryAcknowledgeAlert(session.tenantId, id, session.userId);
  if (!row) return undefined;
  await recordAudit(session.tenantId, session.userId, "alert.acknowledged", { alertId: id });
  const names = new Map((await members(session.tenantId)).map((m) => [m.userId, m.name]));
  return toItem({
    ...row,
    subjectName: row.subjectUserId ? (names.get(row.subjectUserId) ?? null) : null,
    acknowledgedByName: row.acknowledgedBy ? (names.get(row.acknowledgedBy) ?? null) : null,
  });
}

export async function acknowledgeAll(session: NeoSession): Promise<number> {
  const db = getDb();
  const n = db ? await acknowledgeAllAlerts(db, session.tenantId, session.userId) : memoryAcknowledgeAll(session.tenantId, session.userId);
  if (n > 0) await recordAudit(session.tenantId, session.userId, "alert.acknowledged_all", { count: n });
  return n;
}

export async function getThreshold(session: NeoSession): Promise<AlertThreshold> {
  const db = getDb();
  if (!db) return memoryGetThreshold(session.tenantId, session.userId);
  return (await getAlertEmailThreshold(db, session.tenantId, session.userId)) ?? "high";
}

export async function setThreshold(session: NeoSession, threshold: AlertThreshold): Promise<AlertThreshold> {
  const from = await getThreshold(session);
  const db = getDb();
  const stored = db
    ? ((await setAlertEmailThreshold(db, session.tenantId, session.userId, threshold)) ?? threshold)
    : memorySetThreshold(session.tenantId, session.userId, threshold);
  if (from !== stored) await recordAudit(session.tenantId, session.userId, "settings.alert_threshold_changed", { from, to: stored });
  return stored;
}
