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
  countOpenAlerts,
  getAlertEmailThreshold,
  InvalidCursorError,
  listAlerts,
  listMembers,
  setAlertEmailThreshold,
  type AlertListItem,
  type AlertRow,
  type CreateAlertInput,
  type DevicePublic,
  type HouseholdMember,
} from "@neo/db";
import type { SignalDetector, Verdict } from "@neo/verdict";
import { inngest } from "@/inngest/client";
import type { AlertItem, AlertListResponse, AlertThreshold } from "@/lib/alert-types";
import { env, inboundEnv } from "@/lib/env";
import type { NeoSession } from "@/lib/session";
import { recordAudit } from "../audit";
import { getDb } from "../db";
import {
  memoryAcknowledgeAlert,
  memoryAcknowledgeAll,
  memoryCountOpenAlerts,
  memoryGetThreshold,
  memoryListAlerts,
  memorySetThreshold,
} from "../memory-alerts";
import { memoryListMembers } from "../memory-state";
import {
  type AlertText,
  deviceEnrolledAlertText,
  deviceLabel,
  deviceOfflineAlertText,
  deviceRemovedAlertText,
  breachDetectedAlertText,
  displayName,
  hourBucket,
  joinedAlertText,
  leftAlertText,
  mailboxForwardingAlertText,
  spendCapAlertText,
  verdictAlertText,
} from "./templates";
import { createAlertAndEnqueue, createOutboxDrainDeps, drainOutbox, enqueueIfLegacy, type AlertRequestRef } from "./outbox";
import { ALERT_EMAIL_DAILY_CAP, meetsThreshold } from "./recipients";

export { ALERT_EMAIL_DAILY_CAP, meetsThreshold };

export const ALERT_CREATED_EVENT = "neo/alert.created";
export const BREACH_ALERT_KIND = "breach_detected" as const;
export interface AlertCreatedData {
  alertId: string;
  tenantId: string;
}

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

/**
 * The subject part of a correlation dedupe key. A member with an account keeps `<userId>`, so a
 * pair already alerted before member-only devices is not alerted again; a member without one is
 * `m:<memberId>`. Null when neither is known (nothing safe to key on).
 */
export function subjectKey(subject: { userId?: string | null; memberId?: string | null }): string | null {
  if (subject.userId) return subject.userId;
  return subject.memberId ? `m:${subject.memberId}` : null;
}

/** The household's members (database or memory). */
export async function tenantMembers(tenantId: string): Promise<HouseholdMember[]> {
  const db = getDb();
  return db ? listMembers(db, tenantId) : memoryListMembers(tenantId);
}
const members = tenantMembers;

// ─── Raising ───────────────────────────────────────────────────────

/**
 * Insert (deduplicated) with its outbox rows in one transaction, then queue the drain.
 * Never throws.
 */
export async function raiseAlert(input: CreateAlertInput, request?: AlertRequestRef): Promise<AlertRow | null> {
  try {
    const created = await createAlertAndEnqueue(input, request);
    if (!created) return null;
    if (created.enqueued > 0) await queueDelivery({ alertId: created.alert.id, tenantId: created.alert.tenantId });
    return created.alert;
  } catch (err) {
    logger.error("Alert creation failed", "alerts", { tenantId: input.tenantId, errorType: input.kind, errorMessage: errText(err) });
    return null;
  }
}

async function queueDelivery(data: AlertCreatedData): Promise<void> {
  if (env().MOCK_MODE && !inboundEnv().INNGEST_EVENT_KEY) {
    await deliverAlertNow(data).catch((err) =>
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

/** New breach observation for one tenant-scoped address; alert text never contains the address. */
export async function alertBreachDetected(input: {
  tenantId: string;
  userId: string;
  addressId: string;
  breachName: string;
  dataClasses: readonly string[];
}): Promise<void> {
  const text = breachDetectedAlertText(input.breachName, input.dataClasses);
  await raiseAlert({
    tenantId: input.tenantId,
    subjectUserId: input.userId,
    kind: BREACH_ALERT_KIND,
    ...text,
    dedupeKey: `breach_detected:${input.addressId}:${input.breachName}`,
  });
}

/**
 * `spend_cap` (_specs/v2-m3-cutover.md section 6): the household's month-to-date model spend reached 80% or 100% of its
 * cap. Owners only (no subject). One alert per threshold per household month through the dedupe key
 * `spend_cap:<tenantId>:<YYYY-MM>:<80|100>`; `month` is the month in the household's time zone. Never throws.
 */
export async function alertSpendCap(input: {
  tenantId: string;
  month: string;
  percent: 80 | 100;
  spentCents: number;
  capCents: number;
}): Promise<void> {
  await raiseAlert({
    tenantId: input.tenantId,
    subjectUserId: null,
    kind: "spend_cap",
    ...spendCapAlertText(input.percent, input.spentCents, input.capCents),
    dedupeKey: `spend_cap:${input.tenantId}:${input.month}:${input.percent}`,
  });
}

export type ForwardingAlertResult = "raised" | "exists" | "skipped" | "failed";

/**
 * `mailbox_forwarding` (high): a new active forwarding finding on a member's Outlook.com mailbox. Members only (an
 * owner's own mailbox never alerts the household). One alert per finding activation; the text names the domain only.
 * Never throws. `raised` and `exists` (a deduplicated repeat) and `skipped` (policy: nobody to alert) are final;
 * `failed` is transient and the caller retries it.
 */
export async function alertMailboxForwarding(input: {
  tenantId: string;
  userId: string;
  findingId: string;
  observedAt: Date;
  destinationDomain: string | null;
}): Promise<ForwardingAlertResult> {
  try {
    const member = (await members(input.tenantId)).find((m) => m.userId === input.userId);
    if (!member || member.role !== "member") return "skipped";
    const created = await createAlertAndEnqueue({
      tenantId: input.tenantId,
      subjectUserId: input.userId,
      kind: "mailbox_forwarding",
      ...mailboxForwardingAlertText(displayName(member.name, member.email), input.destinationDomain),
      dedupeKey: `mailbox_forwarding:${input.findingId}:${input.observedAt.getTime()}`,
    });
    if (!created) return "exists";
    if (created.enqueued > 0) await queueDelivery({ alertId: created.alert.id, tenantId: created.alert.tenantId });
    return "raised";
  } catch (err) {
    logger.error("Mailbox forwarding alert failed", "alerts", { tenantId: input.tenantId, userIdHash: hashPii(input.userId), errorMessage: errText(err) });
    return "failed";
  }
}

// ─── Devices (_specs/device-enrollment.md) ─────────────────────────

/** What a device alert says about its member: the account's name and email, or only the member's display name. */
type AlertableMember = Pick<HouseholdMember, "name" | "email">;

/**
 * The device's protected member when it may alert: devices protecting an owner (or
 * someone no longer in the household) never do. A member without an account is never an
 * owner, so their devices always alert. Never throws.
 */
async function alertableMember(device: DevicePublic): Promise<AlertableMember | null> {
  try {
    if (!device.userId) return device.memberId ? { name: device.memberName, email: null } : null;
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
    ...(device.memberId ? { memberId: device.memberId } : {}),
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
    ...(device.memberId ? { memberId: device.memberId } : {}),
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
    ...(device.memberId ? { memberId: device.memberId } : {}),
    kind: "device_offline",
    ...deviceOfflineAlertText(displayName(member.name, member.email), deviceLabel(device.name), device.lastSeenAt),
    deviceId: device.id,
    dedupeKey: `device_offline:${device.id}:${since.getTime()}`,
  });
  return row !== null;
}

// ─── Device signals (_specs/signals.md) ─────────────────────────────

/** Alert kinds a signal event can raise directly (everything but the membership/device-lifecycle kinds). */
export type SignalAlertKind =
  | "scam_page"
  | "dangerous_site"
  | "remote_access"
  | "unwanted_software"
  | "permission_grant"
  | "payment_under_pressure"
  | "protection_disabled"
  | "app_approval"
  | "self_harm_attempts";

/**
 * Raise a device-signal alert. Dedupe `<kind>:<deviceId>:<detector>:<subject>:<UTC hour>`, so the
 * same detector and tool/domain/app on the same device alerts at most once an hour (an install
 * alert never swallows a later session alert for the same tool). Owners' own devices alert
 * like everyone else's (decided 2026-09-29, _specs/signals.md): no `alertableMember` gate here.
 */
export async function alertSignal(input: {
  tenantId: string;
  /** The member's account; null for a member without one (then `memberId` is set). */
  userId: string | null;
  deviceId: string;
  kind: SignalAlertKind;
  /** The event's detector (`SignalEvent.detector`), part of the dedupe key. */
  detector: SignalDetector;
  /** The domain, toolId or app name the event is about (device_signals.subject). */
  subject: string;
  verdictId?: string | null;
  text: AlertText;
  /** The protected member row (v2), when known. */
  memberId?: string | null;
  /** The stored signal this alert is about. */
  signalIds?: string[];
  /** The child request this alert is about (`app_approval`): its email goes to the request's recipients with Approve and Deny links. */
  request?: AlertRequestRef;
  now?: Date;
}): Promise<AlertRow | null> {
  return raiseAlert(
    {
      tenantId: input.tenantId,
      subjectUserId: input.userId,
      deviceId: input.deviceId,
      ...(input.memberId !== undefined ? { memberId: input.memberId } : {}),
      ...(input.signalIds ? { signalIds: input.signalIds } : {}),
      kind: input.kind,
      severity: input.text.severity,
      title: input.text.title,
      body: input.text.body,
      ...(input.verdictId ? { verdictId: input.verdictId } : {}),
      dedupeKey: `${input.kind}:${input.deviceId}:${input.detector}:${input.subject}:${hourBucket(input.now)}`,
    },
    input.request,
  );
}

/**
 * The alert that tells the parents about a child's request (`child_request`, or `app_approval` when the
 * policy engine opened an `install_app` request for a new app). One alert per request: the dedupe key is
 * the request id, so a repeat is a no-op. The email goes to the request's recipients (not the owners'
 * thresholds) with the sealed token for Approve and Deny.
 */
export async function alertChildRequest(input: {
  tenantId: string;
  /** The child's account; null for a child without one. */
  userId: string | null;
  memberId: string;
  deviceId: string;
  kind: "child_request" | "app_approval";
  requestId: string;
  token: string;
  text: AlertText;
  signalIds?: string[];
}): Promise<AlertRow | null> {
  return raiseAlert(
    {
      tenantId: input.tenantId,
      subjectUserId: input.userId,
      memberId: input.memberId,
      deviceId: input.deviceId,
      ...(input.signalIds ? { signalIds: input.signalIds } : {}),
      kind: input.kind,
      severity: input.text.severity,
      title: input.text.title,
      body: input.text.body,
      dedupeKey: `${input.kind}:${input.requestId}`,
    },
    { id: input.requestId, token: input.token },
  );
}

/** `warning_bypassed`: dedupe `bypass:<relatesTo>` (one bump alert per dismissed warning). */
export async function alertSignalBypass(input: {
  tenantId: string;
  userId: string | null;
  deviceId: string;
  kind: SignalAlertKind;
  relatesTo: string;
  verdictId?: string | null;
  text: AlertText;
  memberId?: string | null;
  signalIds?: string[];
}): Promise<AlertRow | null> {
  return raiseAlert({
    tenantId: input.tenantId,
    subjectUserId: input.userId,
    deviceId: input.deviceId,
    ...(input.memberId !== undefined ? { memberId: input.memberId } : {}),
    ...(input.signalIds ? { signalIds: input.signalIds } : {}),
    kind: input.kind,
    severity: input.text.severity,
    title: input.text.title,
    body: input.text.body,
    ...(input.verdictId ? { verdictId: input.verdictId } : {}),
    dedupeKey: `bypass:${input.relatesTo}`,
  });
}

/**
 * `scam_in_progress`: dedupe `scam_in_progress:<userId>:<30-minute bucket>`, or
 * `scam_in_progress:m:<memberId>:<bucket>` for a member without an account (see `subjectKey`).
 */
export async function alertScamInProgress(input: {
  tenantId: string;
  userId: string | null;
  bucket: string;
  text: AlertText;
  memberId?: string | null;
  signalIds?: string[];
}): Promise<AlertRow | null> {
  const key = subjectKey(input);
  if (!key) return null;
  return raiseAlert({
    tenantId: input.tenantId,
    subjectUserId: input.userId,
    ...(input.memberId !== undefined ? { memberId: input.memberId } : {}),
    ...(input.signalIds ? { signalIds: input.signalIds } : {}),
    kind: "scam_in_progress",
    severity: input.text.severity,
    title: input.text.title,
    body: input.text.body,
    dedupeKey: `scam_in_progress:${key}:${input.bucket}`,
  });
}

/**
 * `install_during_session` / `payment_under_pressure`: dedupe `<kind>:<userId>:<30-minute bucket>`,
 * or `<kind>:m:<memberId>:<bucket>` for a member without an account (see `subjectKey`).
 */
export async function alertCorrelation(input: {
  tenantId: string;
  userId: string | null;
  kind: "install_during_session" | "payment_under_pressure";
  bucket: string;
  text: AlertText;
  memberId?: string | null;
  signalIds?: string[];
}): Promise<AlertRow | null> {
  const key = subjectKey(input);
  if (!key) return null;
  return raiseAlert({
    tenantId: input.tenantId,
    subjectUserId: input.userId,
    kind: input.kind,
    severity: input.text.severity,
    title: input.text.title,
    body: input.text.body,
    ...(input.memberId !== undefined ? { memberId: input.memberId } : {}),
    ...(input.signalIds ? { signalIds: input.signalIds } : {}),
    dedupeKey: `${input.kind}:${key}:${input.bucket}`,
  });
}

/**
 * `self_harm_attempts` (Child mode): about the child, not one device, so the dedupe key is
 * `self_harm_attempts:<userId>:<UTC hour of the triggering block>` (`m:<memberId>` for a member
 * without an account, see `subjectKey`). Blocks keep arriving after the third; they must not
 * page the parents again within the same hour.
 */
export async function alertSelfHarmAttempts(input: {
  tenantId: string;
  userId: string | null;
  deviceId: string;
  text: AlertText;
  memberId?: string | null;
  signalIds?: string[];
  /** When the triggering block was observed (default now). */
  at?: Date;
}): Promise<AlertRow | null> {
  const key = subjectKey(input);
  if (!key) return null;
  return raiseAlert({
    tenantId: input.tenantId,
    subjectUserId: input.userId,
    deviceId: input.deviceId,
    ...(input.memberId !== undefined ? { memberId: input.memberId } : {}),
    ...(input.signalIds ? { signalIds: input.signalIds } : {}),
    kind: "self_harm_attempts",
    severity: input.text.severity,
    title: input.text.title,
    body: input.text.body,
    dedupeKey: `self_harm_attempts:${key}:${hourBucket(input.at)}`,
  });
}

/** `protection_disabled`: dedupe `protection_disabled:<deviceId>:<UTC hour>`. */
export async function alertProtectionDisabled(input: {
  tenantId: string;
  userId: string | null;
  deviceId: string;
  text: AlertText;
  memberId?: string | null;
  now?: Date;
}): Promise<AlertRow | null> {
  return raiseAlert({
    tenantId: input.tenantId,
    subjectUserId: input.userId,
    deviceId: input.deviceId,
    kind: "protection_disabled",
    severity: input.text.severity,
    title: input.text.title,
    body: input.text.body,
    ...(input.memberId !== undefined ? { memberId: input.memberId } : {}),
    dedupeKey: `protection_disabled:${input.deviceId}:${hourBucket(input.now)}`,
  });
}

// ─── Delivery ──────────────────────────────────────────────────────

/**
 * What the `alert-created` function does: enqueue outbox rows for a legacy alert (raised
 * before the outbox existed, or whose enqueue was deferred), then drain the household.
 */
export async function deliverAlertNow(data: AlertCreatedData, now = new Date()): Promise<{ enqueued: number; retry: number }> {
  const enqueued = await enqueueIfLegacy(data.tenantId, data.alertId);
  const r = await drainOutbox(data.tenantId, createOutboxDrainDeps(), now, { alertId: data.alertId });
  return { enqueued, retry: r.retry };
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
    status: a.status,
    acknowledgedAt: a.acknowledgedAt ? a.acknowledgedAt.toISOString() : null,
    acknowledgedByName: a.acknowledgedByName,
  };
}

export class BadCursorError extends Error {}

/** The alert filter of a session: owners see the household's alerts; members only those about their own member. */
function alertScope(session: NeoSession): { aboutUserId?: string } {
  return session.role === "owner" ? {} : { aboutUserId: session.userId };
}

/** Owners see the household's alerts; members only those about themselves. */
export async function listAlertsForSession(
  session: NeoSession,
  opts: { status: "open" | "all"; cursor?: string; limit?: number },
): Promise<AlertListResponse> {
  const scope = alertScope(session);
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
    const scope = alertScope(session);
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
