/**
 * In-memory alerts and owner thresholds when DATABASE_URL is unset (MOCK_MODE,
 * tests). Mirrors @neo/db alerts.ts; names come from the shared members map.
 */
import {
  ALERT_BODY_MAX,
  ALERT_TITLE_MAX,
  OUTBOX_LEASE_MS,
  OUTBOX_MAX_ATTEMPTS,
  decideEnqueue,
  encryptContact,
  utcDayStart,
  type AlertEnqueuePlan,
  type AlertListItem,
  type AlertOwner,
  type AlertRow,
  type CreateAlertInput,
  type OutboxRow,
  type OutboxRowInput,
} from "@neo/db";
import { memoryMemberById, memoryMemberIdForUser } from "./memory-members";
import { memoryListMembers } from "./memory-state";

type Threshold = AlertOwner["threshold"];

const g = globalThis as typeof globalThis & {
  __neoMemoryAlerts?: { rows: AlertRow[]; thresholds: Map<string, Threshold>; outbox: OutboxRow[] };
};

function state() {
  g.__neoMemoryAlerts ??= { rows: [], thresholds: new Map(), outbox: [] };
  return g.__neoMemoryAlerts;
}

export function resetMemoryAlerts(): void {
  g.__neoMemoryAlerts = undefined;
}

export function memoryAlertRows(): AlertRow[] {
  return state().rows;
}

function clip(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : chars.slice(0, max - 1).join("") + "…";
}

function nameOf(tenantId: string, userId: string | null): string | null {
  if (!userId) return null;
  return memoryListMembers(tenantId).find((m) => m.userId === userId)?.name ?? null;
}

export function memoryCreateAlert(input: CreateAlertInput): AlertRow | null {
  const rows = state().rows;
  if (rows.some((r) => r.tenantId === input.tenantId && r.dedupeKey === input.dedupeKey)) return null;
  const row: AlertRow = {
    id: crypto.randomUUID(),
    tenantId: input.tenantId,
    subjectUserId: input.subjectUserId,
    deviceId: input.deviceId ?? null,
    kind: input.kind,
    severity: input.severity,
    title: clip(input.title, ALERT_TITLE_MAX),
    body: clip(input.body, ALERT_BODY_MAX),
    verdictId: input.verdictId ?? null,
    memberId: input.memberId ?? null,
    status: "open",
    signalIds: input.signalIds ?? [],
    eveSessionId: null,
    resolvedAt: null,
    dedupeKey: input.dedupeKey,
    createdAt: input.now ?? new Date(),
    acknowledgedAt: null,
    acknowledgedBy: null,
    emailStatus: "pending",
    emailedAt: null,
  };
  rows.push(row);
  if (rows.length > 1000) rows.splice(0, rows.length - 1000);
  return row;
}

export function memoryGetAlert(tenantId: string, id: string): AlertRow | undefined {
  return state().rows.find((r) => r.tenantId === tenantId && r.id === id);
}

type SubjectFilter = { subjectUserId?: string; memberId?: string; aboutUserId?: string };

function visible(tenantId: string, opts: SubjectFilter & { status?: "open" | "all" }): AlertRow[] {
  return state()
    .rows.filter((r) => r.tenantId === tenantId)
    .filter((r) => opts.subjectUserId === undefined || r.subjectUserId === opts.subjectUserId)
    .filter((r) => opts.memberId === undefined || r.memberId === opts.memberId)
    // A member's own view: alerts about the member behind this account, by member row or subject user.
    .filter((r) => opts.aboutUserId === undefined || r.subjectUserId === opts.aboutUserId || (r.memberId !== null && r.memberId === memoryMemberIdForUser(tenantId, opts.aboutUserId!)))
    .filter((r) => opts.status !== "open" || !r.acknowledgedAt)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1));
}

/** Offset cursor (base64url of the next index); the database uses a keyset cursor. */
export function memoryListAlerts(
  tenantId: string,
  opts: SubjectFilter & { status?: "open" | "all"; cursor?: string; limit?: number },
): { items: AlertListItem[]; nextCursor?: string } {
  const limit = Math.max(1, Math.min(Math.floor(opts.limit ?? 20) || 20, 50));
  let start = 0;
  if (opts.cursor) {
    const raw = /^[A-Za-z0-9_-]+$/.test(opts.cursor) ? Buffer.from(opts.cursor, "base64url").toString("utf8") : "";
    if (!/^\d+$/.test(raw)) throw new Error("invalid cursor");
    start = Number(raw);
  }
  const all = visible(tenantId, opts);
  const page = all.slice(start, start + limit).map((r) => ({
    ...r,
    subjectName: r.subjectUserId ? nameOf(tenantId, r.subjectUserId) : r.memberId ? (memoryMemberById(tenantId, r.memberId)?.displayName ?? null) : null,
    acknowledgedByName: nameOf(tenantId, r.acknowledgedBy),
  }));
  const next = start + limit;
  return { items: page, ...(next < all.length ? { nextCursor: Buffer.from(String(next), "utf8").toString("base64url") } : {}) };
}

export function memoryCountOpenAlerts(tenantId: string, opts: SubjectFilter & { severities?: readonly string[] }): number {
  return visible(tenantId, { ...opts, status: "open" }).filter((r) => !opts.severities?.length || opts.severities.includes(r.severity)).length;
}

export function memoryAcknowledgeAlert(tenantId: string, id: string, userId: string): AlertRow | undefined {
  const r = memoryGetAlert(tenantId, id);
  if (r && !r.acknowledgedAt) {
    r.acknowledgedAt = new Date();
    r.acknowledgedBy = userId;
    r.status = "acknowledged";
  }
  return r;
}

export function memoryAcknowledgeAll(tenantId: string, userId: string): number {
  const open = visible(tenantId, { status: "open" });
  for (const r of open) {
    r.acknowledgedAt = new Date();
    r.acknowledgedBy = userId;
    r.status = "acknowledged";
  }
  return open.length;
}

export function memoryMarkAlertEmail(tenantId: string, id: string, status: AlertRow["emailStatus"]): void {
  const r = memoryGetAlert(tenantId, id);
  if (!r) return;
  r.emailStatus = status;
  r.emailedAt = status === "sent" ? new Date() : null;
}

export function memoryCountAlertEmailsSince(tenantId: string, since: Date): number {
  return state().rows.filter((r) => r.tenantId === tenantId && r.emailStatus === "sent" && r.emailedAt && r.emailedAt >= since).length;
}

export function memoryAlertOwners(tenantId: string): AlertOwner[] {
  return memoryListMembers(tenantId)
    .filter((m) => m.role === "owner")
    .map((m) => ({ userId: m.userId, email: m.email, name: m.name, threshold: state().thresholds.get(`${tenantId}:${m.userId}`) ?? "high" }));
}

export function memoryGetThreshold(tenantId: string, userId: string): Threshold {
  return state().thresholds.get(`${tenantId}:${userId}`) ?? "high";
}

export function memorySetThreshold(tenantId: string, userId: string, threshold: Threshold): Threshold {
  state().thresholds.set(`${tenantId}:${userId}`, threshold);
  return threshold;
}

// ─── Notification outbox (twin of @neo/db outbox.ts) ───────────────

export function memoryOutboxRows(): OutboxRow[] {
  return state().outbox;
}

function insertMemoryOutbox(tenantId: string, alertId: string, rows: OutboxRowInput[]): number {
  const outbox = state().outbox;
  let n = 0;
  for (const r of rows) {
    if (outbox.some((o) => o.idempotencyKey === r.idempotencyKey)) continue;
    outbox.push({
      id: crypto.randomUUID(),
      tenantId,
      idempotencyKey: r.idempotencyKey,
      channel: "email",
      destinationCiphertext: encryptContact(tenantId, r.idempotencyKey, r.address),
      template: r.template,
      payload: r.payload,
      alertId,
      recipientMemberId: r.recipientMemberId,
      recipientUserId: r.recipientUserId,
      attempts: 0,
      leaseUntil: null,
      sentAt: null,
      providerId: null,
      lastError: null,
      createdAt: new Date(),
    });
    n++;
  }
  if (outbox.length > 2000) outbox.splice(0, outbox.length - 2000);
  return n;
}

function enqueueMemory(alert: AlertRow, plan: AlertEnqueuePlan): { alert: AlertRow; enqueued: number; capped: boolean } {
  const dayStart = utcDayStart(alert.createdAt);
  const admitted = state().rows.filter(
    (r) => r.tenantId === alert.tenantId && r.id !== alert.id && r.createdAt >= dayStart && (r.emailStatus === "pending" || r.emailStatus === "sent"),
  ).length;
  const d = decideEnqueue(alert, plan, plan.rows(alert), () => plan.capRows(alert, dayStart), admitted);
  if (d.status === "skipped") {
    alert.emailStatus = "skipped";
    alert.emailedAt = null;
  }
  return { alert, enqueued: insertMemoryOutbox(alert.tenantId, alert.id, d.rows), capped: d.capped };
}

export function memoryCreateAlertWithOutbox(input: CreateAlertInput, plan: AlertEnqueuePlan): { alert: AlertRow; enqueued: number; capped: boolean } | null {
  const alert = memoryCreateAlert(input);
  return alert ? enqueueMemory(alert, plan) : null;
}

export function memoryEnqueueOutboxForAlert(tenantId: string, alertId: string, plan: AlertEnqueuePlan): { enqueued: number; capped: boolean } {
  const alert = memoryGetAlert(tenantId, alertId);
  if (!alert || alert.emailStatus !== "pending" || state().outbox.some((o) => o.alertId === alertId)) return { enqueued: 0, capped: false };
  const r = enqueueMemory(alert, plan);
  return { enqueued: r.enqueued, capped: r.capped };
}

export function memoryClaimOutbox(tenantId: string, now: Date, limit: number): OutboxRow[] {
  const due = state()
    .outbox.filter((o) => o.tenantId === tenantId && !o.sentAt && o.attempts < OUTBOX_MAX_ATTEMPTS && (!o.leaseUntil || o.leaseUntil < now))
    .slice(0, limit);
  for (const o of due) {
    o.leaseUntil = new Date(now.getTime() + OUTBOX_LEASE_MS);
    o.attempts += 1;
  }
  return due.map((o) => ({ ...o }));
}

export function memoryMarkOutboxSent(tenantId: string, id: string, providerId: string, now: Date): void {
  const o = state().outbox.find((x) => x.tenantId === tenantId && x.id === id);
  if (!o) return;
  o.sentAt = now;
  o.providerId = providerId || null;
  o.leaseUntil = null;
  o.lastError = null;
}

export function memoryMarkOutboxFailed(tenantId: string, id: string, error: string, permanent: boolean): void {
  const o = state().outbox.find((x) => x.tenantId === tenantId && x.id === id);
  if (!o) return;
  o.lastError = error.slice(0, 300);
  o.leaseUntil = null;
  if (permanent) o.attempts = OUTBOX_MAX_ATTEMPTS;
}

export function memorySettleAlertEmail(tenantId: string, alertId: string, now: Date): AlertRow["emailStatus"] | undefined {
  const rows = state().outbox.filter((o) => o.tenantId === tenantId && o.alertId === alertId && o.template === "alert");
  if (rows.length === 0) return undefined;
  const status = rows.some((r) => !r.sentAt && r.attempts >= OUTBOX_MAX_ATTEMPTS) ? "failed" : rows.every((r) => r.sentAt) ? "sent" : undefined;
  if (!status) return undefined;
  const alert = memoryGetAlert(tenantId, alertId);
  if (alert && alert.emailStatus === "pending") {
    alert.emailStatus = status;
    alert.emailedAt = status === "sent" ? now : null;
  }
  return status;
}

export function memoryPendingOutboxTenants(): string[] {
  return [...new Set(state().outbox.filter((o) => !o.sentAt && o.attempts < OUTBOX_MAX_ATTEMPTS).map((o) => o.tenantId))];
}
