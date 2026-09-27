/**
 * In-memory alerts and owner thresholds when DATABASE_URL is unset (MOCK_MODE,
 * tests). Mirrors @neo/db alerts.ts; names come from the shared members map.
 */
import { ALERT_BODY_MAX, ALERT_TITLE_MAX, type AlertListItem, type AlertOwner, type AlertRow, type CreateAlertInput } from "@neo/db";
import { memoryListMembers } from "./memory-state";

type Threshold = AlertOwner["threshold"];

const g = globalThis as typeof globalThis & { __neoMemoryAlerts?: { rows: AlertRow[]; thresholds: Map<string, Threshold> } };

function state() {
  g.__neoMemoryAlerts ??= { rows: [], thresholds: new Map() };
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

function visible(tenantId: string, opts: { subjectUserId?: string; status?: "open" | "all" }): AlertRow[] {
  return state()
    .rows.filter((r) => r.tenantId === tenantId)
    .filter((r) => opts.subjectUserId === undefined || r.subjectUserId === opts.subjectUserId)
    .filter((r) => opts.status !== "open" || !r.acknowledgedAt)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1));
}

/** Offset cursor (base64url of the next index); the database uses a keyset cursor. */
export function memoryListAlerts(
  tenantId: string,
  opts: { subjectUserId?: string; status?: "open" | "all"; cursor?: string; limit?: number },
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
    subjectName: nameOf(tenantId, r.subjectUserId),
    acknowledgedByName: nameOf(tenantId, r.acknowledgedBy),
  }));
  const next = start + limit;
  return { items: page, ...(next < all.length ? { nextCursor: Buffer.from(String(next), "utf8").toString("base64url") } : {}) };
}

export function memoryCountOpenAlerts(tenantId: string, opts: { subjectUserId?: string; severities?: readonly string[] }): number {
  return visible(tenantId, { ...opts, status: "open" }).filter((r) => !opts.severities?.length || opts.severities.includes(r.severity)).length;
}

export function memoryAcknowledgeAlert(tenantId: string, id: string, userId: string): AlertRow | undefined {
  const r = memoryGetAlert(tenantId, id);
  if (r && !r.acknowledgedAt) {
    r.acknowledgedAt = new Date();
    r.acknowledgedBy = userId;
  }
  return r;
}

export function memoryAcknowledgeAll(tenantId: string, userId: string): number {
  const open = visible(tenantId, { status: "open" });
  for (const r of open) {
    r.acknowledgedAt = new Date();
    r.acknowledgedBy = userId;
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
