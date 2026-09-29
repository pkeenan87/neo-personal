/**
 * Device signals, expected remote-access tools and the shared reputation cache
 * (_specs/signals.md). `device_signals` / `device_expected_tools` are tenant-scoped through
 * `tenantScoped()`; `reputation_cache` carries no tenant and no RLS, so it is queried with the
 * raw `db` (see docs/rls.md).
 */
import { and, asc, eq, gte, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { Db } from "./client.js";
import { devices, deviceExpectedTools, deviceSignals, reputationCache, SIGNAL_OUTCOMES, type SignalOutcome, type SignalSeverity } from "./schema/index.js";
import { assertTenantId, tenantScoped } from "./tenant.js";

export { SIGNAL_OUTCOMES };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DeviceSignalRow = typeof deviceSignals.$inferSelect;

export interface InsertDeviceSignalInput {
  tenantId: string;
  deviceId: string;
  userId: string;
  clientEventId: string;
  type: string;
  detector: string;
  subject: string;
  payload: Record<string, unknown>;
  observedAt: Date;
  escalated?: boolean;
  /** Backdates received_at; defaults to now. */
  now?: Date;
}

/**
 * Insert a device signal. On a duplicate `(device_id, client_event_id)` the existing row is
 * fetched (tenant-scoped) and returned with `duplicate: true`, so a retried batch is a no-op.
 */
export async function insertDeviceSignal(db: Db, input: InsertDeviceSignalInput): Promise<{ row: DeviceSignalRow; duplicate: boolean }> {
  assertTenantId(input.tenantId);
  return tenantScoped(db, input.tenantId).transaction(async (t) => {
    const [inserted] = await t.tx
      .insert(deviceSignals)
      .values({
        tenantId: input.tenantId,
        deviceId: input.deviceId,
        userId: input.userId,
        clientEventId: input.clientEventId,
        type: input.type,
        detector: input.detector,
        subject: input.subject,
        payload: input.payload,
        observedAt: input.observedAt,
        escalated: input.escalated ?? false,
        ...(input.now ? { receivedAt: input.now } : {}),
      })
      .onConflictDoNothing({ target: [deviceSignals.deviceId, deviceSignals.clientEventId] })
      .returning();
    if (inserted) return { row: inserted, duplicate: false };
    const [existing] = await t.tx
      .select()
      .from(deviceSignals)
      .where(
        and(
          eq(deviceSignals.tenantId, input.tenantId),
          eq(deviceSignals.deviceId, input.deviceId),
          eq(deviceSignals.clientEventId, input.clientEventId),
        ),
      )
      .limit(1);
    if (!existing) throw new Error("@neo/db: device signal insert conflicted but no existing row was found");
    return { row: existing, duplicate: true };
  });
}

export async function getDeviceSignal(db: Db, tenantId: string, id: string): Promise<DeviceSignalRow | undefined> {
  if (!UUID_RE.test(id)) return undefined;
  return tenantScoped(db, tenantId).first(deviceSignals, eq(deviceSignals.id, id));
}

export interface UpdateDeviceSignalPatch {
  severity?: SignalSeverity | null;
  outcome?: SignalOutcome;
  verdictId?: string | null;
  alertId?: string | null;
}

/** Patch a signal's outcome/severity/links once it has been ruled on. Undefined for unknown ids. */
export async function updateDeviceSignal(
  db: Db,
  tenantId: string,
  id: string,
  patch: UpdateDeviceSignalPatch,
): Promise<DeviceSignalRow | undefined> {
  if (!UUID_RE.test(id)) return undefined;
  const set: Record<string, unknown> = {};
  if (patch.severity !== undefined) set.severity = patch.severity;
  if (patch.outcome !== undefined) set.outcome = patch.outcome;
  if (patch.verdictId !== undefined) set.verdictId = patch.verdictId;
  if (patch.alertId !== undefined) set.alertId = patch.alertId;
  if (Object.keys(set).length === 0) return getDeviceSignal(db, tenantId, id);
  const [row] = await tenantScoped(db, tenantId).update(deviceSignals, set, eq(deviceSignals.id, id));
  return row;
}

/** A member's signals since `since`, oldest first (for correlation). */
export async function listRecentUserSignals(
  db: Db,
  tenantId: string,
  userId: string,
  opts: { since: Date; outcomes?: readonly SignalOutcome[] },
): Promise<DeviceSignalRow[]> {
  const conds: SQL[] = [eq(deviceSignals.userId, userId), gte(deviceSignals.observedAt, opts.since)];
  if (opts.outcomes?.length) conds.push(inArray(deviceSignals.outcome, [...opts.outcomes]));
  return tenantScoped(db, tenantId).select(deviceSignals, and(...conds), { orderBy: [asc(deviceSignals.observedAt)] });
}

/** How many signals a device has sent since `since` (received_at), for the daily rate limit. */
export async function countDeviceSignalsSince(
  db: Db,
  tenantId: string,
  deviceId: string,
  since: Date,
  opts: { escalatedOnly?: boolean } = {},
): Promise<number> {
  const conds: SQL[] = [eq(deviceSignals.deviceId, deviceId), gte(deviceSignals.receivedAt, since)];
  if (opts.escalatedOnly) conds.push(eq(deviceSignals.escalated, true));
  return tenantScoped(db, tenantId).count(deviceSignals, and(...conds));
}

/** Retention: device_signals rows older than 30 days by received_at, across tenants. */
export async function purgeOldDeviceSignals(db: Db): Promise<number> {
  const res = await db.execute(sql`select purge_old_device_signals() as n`);
  const [r] = (res as unknown as { rows: Array<{ n: number | string }> }).rows;
  return Number(r?.n ?? 0);
}

export interface ExpectedToolRow {
  deviceId: string;
  toolId: string;
  peerIds: string[];
  createdBy: string | null;
  createdAt: Date;
}

function toExpectedToolRow(r: typeof deviceExpectedTools.$inferSelect): ExpectedToolRow {
  return { deviceId: r.deviceId, toolId: r.toolId, peerIds: r.peerIds, createdBy: r.createdBy, createdAt: r.createdAt };
}

/** Expected remote-access tools for the household, or one device. */
export async function listExpectedTools(db: Db, tenantId: string, opts: { deviceId?: string } = {}): Promise<ExpectedToolRow[]> {
  const where = opts.deviceId !== undefined ? eq(deviceExpectedTools.deviceId, opts.deviceId) : undefined;
  const rows = await tenantScoped(db, tenantId).select(deviceExpectedTools, where);
  return rows.map(toExpectedToolRow);
}

export interface SetExpectedToolsInput {
  tenantId: string;
  deviceId: string;
  tools: { toolId: string; peerIds: string[] }[];
  createdBy: string;
  now?: Date;
}

/**
 * Replace a device's expected-tools set in one transaction. Undefined when the device does
 * not exist in this tenant or has been revoked; otherwise the new set (possibly empty).
 */
export async function setExpectedTools(db: Db, input: SetExpectedToolsInput): Promise<ExpectedToolRow[] | undefined> {
  assertTenantId(input.tenantId);
  return tenantScoped(db, input.tenantId).transaction(async (t) => {
    const [device] = await t.tx
      .select({ id: devices.id })
      .from(devices)
      .where(and(eq(devices.tenantId, input.tenantId), eq(devices.id, input.deviceId), isNull(devices.revokedAt)))
      .limit(1);
    if (!device) return undefined;

    await t.tx
      .delete(deviceExpectedTools)
      .where(and(eq(deviceExpectedTools.tenantId, input.tenantId), eq(deviceExpectedTools.deviceId, input.deviceId)));

    if (input.tools.length === 0) return [];

    const rows = await t.tx
      .insert(deviceExpectedTools)
      .values(
        input.tools.map((tool) => ({
          tenantId: input.tenantId,
          deviceId: input.deviceId,
          toolId: tool.toolId,
          peerIds: tool.peerIds,
          createdBy: input.createdBy,
          ...(input.now ? { createdAt: input.now } : {}),
        })),
      )
      .returning();
    return rows.map(toExpectedToolRow);
  });
}

// ─── Shared reputation cache ────────────────────────────────────────

/**
 * `reputation_cache`-backed cache of public reputation facts (domain/hash lookups), shared
 * across households, 24h TTL. Structurally compatible with @neo/tools' `ReputationCache`
 * (`get(key): Promise<unknown>`, `set(key, value, ttlSeconds): Promise<void>`); @neo/db does
 * not depend on @neo/tools, so the interface is not imported, only satisfied.
 */
export class PostgresReputationCache {
  constructor(private readonly db: Db) {}

  /** Never throws: a lookup failure (or an expired/missing key) is a cache miss. */
  async get(key: string): Promise<unknown> {
    try {
      const [row] = await this.db.select().from(reputationCache).where(eq(reputationCache.key, key)).limit(1);
      if (!row || row.expiresAt.getTime() <= Date.now()) return undefined;
      return row.value;
    } catch {
      return undefined;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    const expiresAt = new Date(Date.now() + Math.max(0, ttlSeconds) * 1000);
    await this.db
      .insert(reputationCache)
      .values({ key, value, expiresAt })
      .onConflictDoUpdate({ target: reputationCache.key, set: { value, expiresAt } });
  }
}

/** Retention: expired reputation_cache rows. */
export async function purgeExpiredReputationCache(db: Db): Promise<number> {
  const res = await db.execute(sql`select purge_expired_reputation_cache() as n`);
  const [r] = (res as unknown as { rows: Array<{ n: number | string }> }).rows;
  return Number(r?.n ?? 0);
}
