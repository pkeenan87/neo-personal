import { and, eq, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { digestDeliveries, memberships, type DigestDeliveryState } from "./schema/index.js";
import { tenantScoped } from "./tenant.js";
export type DigestDelivery = {
  tenantId: string; userId: string; isoWeek: string; state: DigestDeliveryState;
  periodStart: Date; periodEnd: Date; claimedAt?: Date; runId?: string;
  providerMessageId?: string; createdAt: Date; updatedAt: Date;
};
export type DigestClaim = { tenantId: string; userId: string; isoWeek: string; periodStart: Date; periodEnd: Date; runId: string; now: Date };
export type DigestClaimResult = { result: "claimed" | "owned_live" | "terminal" | "household_move_collision"; delivery?: DigestDelivery };
function delivery(row: typeof digestDeliveries.$inferSelect): DigestDelivery {
  return { ...row, claimedAt: row.claimedAt ?? undefined, runId: row.runId ?? undefined, providerMessageId: row.providerMessageId ?? undefined };
}
const key = (userId: string, isoWeek: string) => and(eq(digestDeliveries.userId, userId), eq(digestDeliveries.isoWeek, isoWeek));
export const weeklyDigest = {
  async listDigestRecipientPairs(db: Db, opts: { cursor?: string; limit: number }): Promise<{ items: Array<{ tenantId: string; userId: string }>; nextCursor?: string }> {
    if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 1000) throw new Error("digest page limit must be 1..1000");
    const cursor = opts.cursor ? JSON.parse(opts.cursor) as [string, string] : undefined;
    const rows = await db.execute(sql`select * from public.list_digest_recipients(${cursor?.[0] ?? null}::uuid, ${cursor?.[1] ?? null}::text, ${opts.limit}::integer)`) as { rows: Array<{ tenant_id: string; user_id: string }> };
    const items = rows.rows.map(row => ({ tenantId: row.tenant_id, userId: row.user_id }));
    const last = items.at(-1);
    return { items, ...(items.length === opts.limit && last ? { nextCursor: JSON.stringify([last.tenantId, last.userId]) } : {}) };
  },
  async getPreference(db: Db, tenantId: string, userId: string): Promise<boolean | undefined> {
    return (await tenantScoped(db, tenantId).first(memberships, eq(memberships.userId, userId)))?.weeklyDigestEnabled;
  },
  async setPreference(db: Db, tenantId: string, userId: string, enabled: boolean): Promise<boolean> {
    return (await tenantScoped(db, tenantId).update(memberships, { weeklyDigestEnabled: enabled }, eq(memberships.userId, userId))).length > 0;
  },
  async getDelivery(db: Db, tenantId: string, userId: string, isoWeek: string): Promise<DigestDelivery | undefined> {
    const row = await tenantScoped(db, tenantId).first(digestDeliveries, key(userId, isoWeek));
    return row ? delivery(row) : undefined;
  },
  async claimDelivery(db: Db, input: DigestClaim): Promise<DigestClaimResult> {
    return tenantScoped(db, input.tenantId).transaction(async t => {
      // Serialize claims without reading any other tenant's row.
      await t.tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"digest:" + input.userId + ":" + input.isoWeek}, 0))`);
      const [inserted] = await t.tx.insert(digestDeliveries).values({
        tenantId: input.tenantId, userId: input.userId, isoWeek: input.isoWeek,
        periodStart: input.periodStart, periodEnd: input.periodEnd,
        state: "sending", runId: input.runId, claimedAt: input.now, createdAt: input.now, updatedAt: input.now,
      }).onConflictDoNothing().returning();
      if (inserted) return { result: "claimed", delivery: delivery(inserted) };
      const row = await t.first(digestDeliveries, key(input.userId, input.isoWeek));
      if (!row) return { result: "household_move_collision" };
      if (row.state !== "sending") return { result: "terminal", delivery: delivery(row) };
      if (row.runId === input.runId) return { result: "claimed", delivery: delivery(row) };
      if (row.claimedAt && +input.now - +row.claimedAt < 15 * 60_000) return { result: "owned_live" };
      const [updated] = await t.update(digestDeliveries, { runId: input.runId, claimedAt: input.now, updatedAt: input.now }, key(input.userId, input.isoWeek));
      return { result: "claimed", delivery: delivery(updated!) };
    });
  },
  async finishDelivery(db: Db, input: { tenantId: string; userId: string; isoWeek: string; runId: string; state: "sent" | "empty" | "failed"; providerMessageId?: string; now: Date }): Promise<void> {
    await tenantScoped(db, input.tenantId).update(digestDeliveries, {
      state: input.state, providerMessageId: input.providerMessageId, updatedAt: input.now,
    }, and(key(input.userId, input.isoWeek), eq(digestDeliveries.runId, input.runId), eq(digestDeliveries.state, "sending")));
  },
};
