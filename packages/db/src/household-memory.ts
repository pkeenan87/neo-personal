/**
 * Household memory (_specs/v2-m3-cutover.md section 3): short owner-approved facts the eve agent can
 * `recall`. Every query is tenant-scoped; the cap is checked in the same transaction as the insert.
 * Text rules (no contact details, secrets or payment data) are the caller's job: see
 * apps/web/lib/server/household-memory.ts. Forgetting is a hard delete.
 */
import { and, asc, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { householdMemory, members, tenants, type HouseholdMemorySource } from "./schema/index.js";
import type { TenantDb } from "./tenant.js";

export type HouseholdMemoryRow = typeof householdMemory.$inferSelect;

export const HOUSEHOLD_MEMORY_MAX = 100;
export const HOUSEHOLD_MEMORY_RETENTION_DAYS = 365;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AddMemoryResult =
  | { outcome: "created"; row: HouseholdMemoryRow }
  | { outcome: "duplicate"; row: HouseholdMemoryRow }
  | { outcome: "limit" }
  | { outcome: "bad_subject" };

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Store one memory. `subjectMemberId` must be a member of this household. An identical live entry (same
 * text, same subject) is returned instead of added twice. At most 100 live entries per household.
 */
export async function addHouseholdMemory(
  tdb: TenantDb,
  input: { text: string; subjectMemberId: string | null; createdBy: string; source: HouseholdMemorySource; now?: Date },
): Promise<AddMemoryResult> {
  const now = input.now ?? new Date();
  return tdb.transaction(async (t): Promise<AddMemoryResult> => {
    if (input.subjectMemberId) {
      if (!UUID_RE.test(input.subjectMemberId)) return { outcome: "bad_subject" };
      const subject = await t.first(members, eq(members.id, input.subjectMemberId));
      if (!subject) return { outcome: "bad_subject" };
    }
    // Serialize adds for this household so two at once cannot both pass the cap.
    await t.tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"household_memory:" + t.tenantId}))`);
    const live = await t.select(householdMemory, gt(householdMemory.expiresAt, now));
    const dup = live.find((r) => same(r.text, input.text) && (r.subjectMemberId ?? null) === (input.subjectMemberId ?? null));
    if (dup) return { outcome: "duplicate", row: dup };
    if (live.length >= HOUSEHOLD_MEMORY_MAX) return { outcome: "limit" };
    // The household's retention setting (migration 0030); null = the default 365 days.
    const [setting] = await t.tx.select({ days: tenants.retentionMemoryDays }).from(tenants).where(eq(tenants.id, t.tenantId)).limit(1);
    const expiresAt = new Date(now.getTime() + (setting?.days ?? HOUSEHOLD_MEMORY_RETENTION_DAYS) * 24 * 60 * 60 * 1000);
    const [row] = await t.insert(householdMemory, {
      text: input.text,
      subjectMemberId: input.subjectMemberId,
      createdBy: input.createdBy,
      source: input.source,
      createdAt: now,
      expiresAt,
    });
    if (!row) throw new Error("household memory insert failed");
    return { outcome: "created", row };
  });
}

/**
 * Live (unexpired) memories, oldest first. `forMemberId` narrows to the household-wide ones plus those about
 * that member (a non-owner's view; null means a viewer with no member row sees only household-wide ones);
 * undefined is the owner's view of everything.
 */
export async function listHouseholdMemory(tdb: TenantDb, opts: { forMemberId?: string | null; now?: Date } = {}): Promise<HouseholdMemoryRow[]> {
  const now = opts.now ?? new Date();
  const live = gt(householdMemory.expiresAt, now);
  const scope =
    opts.forMemberId === undefined
      ? live
      : and(live, opts.forMemberId === null ? isNull(householdMemory.subjectMemberId) : or(isNull(householdMemory.subjectMemberId), eq(householdMemory.subjectMemberId, opts.forMemberId)));
  return tdb.select(householdMemory, scope, { orderBy: [asc(householdMemory.createdAt), asc(householdMemory.id)], limit: HOUSEHOLD_MEMORY_MAX });
}

/** Hard delete, at once. Returns whether a row of this household was removed. */
export async function forgetHouseholdMemory(tdb: TenantDb, id: string): Promise<boolean> {
  if (!UUID_RE.test(id)) return false;
  return (await tdb.delete(householdMemory, eq(householdMemory.id, id))).length > 0;
}

/** Retention, across households (`purge_expired_household_memory`, security definer): deletes entries past `expires_at`. Returns the count. */
export async function purgeExpiredHouseholdMemory(db: Db, now = new Date()): Promise<number> {
  const res = await db.execute(sql`select public.purge_expired_household_memory(${now.toISOString()}::timestamptz) as n`);
  return Number((res as unknown as { rows: Array<{ n: number | string }> }).rows[0]?.n ?? 0);
}
