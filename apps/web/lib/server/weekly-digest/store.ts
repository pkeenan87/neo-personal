import type { DigestDelivery, DigestClaim, DigestClaimResult } from "@neo/db";
import { memoryListMembers, memoryState } from "../memory-state";
import { DIGEST_RESUME_LEASE_MS } from "./period";
export interface WeeklyDigestStore {
  getPreference(tenantId: string, userId: string): Promise<boolean | undefined>;
  setPreference(tenantId: string, userId: string, enabled: boolean): Promise<boolean>;
  getDelivery(tenantId: string, userId: string, isoWeek: string): Promise<DigestDelivery | undefined>;
  claimDelivery(input: DigestClaim): Promise<DigestClaimResult>;
  finishDelivery(input: { tenantId: string; userId: string; isoWeek: string; runId: string; state: "sent" | "empty" | "failed"; providerMessageId?: string; now: Date }): Promise<void>;
}
export interface DigestRecipientStore {
  listDigestRecipientPairs(cursor?: string, limit?: number): Promise<{ items: Array<{ tenantId: string; userId: string }>; nextCursor?: string }>;
}
export function createMemoryWeeklyDigestStore(): WeeklyDigestStore {
  const deliveries = new Map<string, DigestDelivery>();
  const key = (userId: string, isoWeek: string) => JSON.stringify([userId, isoWeek]);
  return {
    async getPreference(tenantId, userId) {
      const member = memoryListMembers(tenantId).find(m => m.userId === userId);
      if (!member) return undefined;
      return memoryState().digestPreferences.get(`${tenantId}:${userId}`) ?? member.role === "owner";
    },
    async setPreference(tenantId, userId, enabled) {
      if (!memoryListMembers(tenantId).some(m => m.userId === userId)) return false;
      memoryState().digestPreferences.set(`${tenantId}:${userId}`, enabled);
      return true;
    },
    async getDelivery(tenantId, userId, isoWeek) {
      const row = deliveries.get(key(userId, isoWeek));
      return row?.tenantId === tenantId ? structuredClone(row) : undefined;
    },
    async claimDelivery(input) {
      const id = key(input.userId, input.isoWeek);
      const existing = deliveries.get(id);
      if (existing) {
        if (existing.tenantId !== input.tenantId) return { result: "household_move_collision" };
        if (existing.state !== "sending") return { result: "terminal", delivery: structuredClone(existing) };
        if (existing.runId !== input.runId) {
          if (existing.claimedAt && +input.now - +existing.claimedAt < DIGEST_RESUME_LEASE_MS) return { result: "owned_live" };
          existing.runId = input.runId;
          existing.claimedAt = input.now;
          existing.updatedAt = input.now;
        }
        return { result: "claimed", delivery: structuredClone(existing) };
      }
      const row: DigestDelivery = { tenantId: input.tenantId, userId: input.userId, isoWeek: input.isoWeek, periodStart: input.periodStart, periodEnd: input.periodEnd, state: "sending", runId: input.runId, claimedAt: input.now, createdAt: input.now, updatedAt: input.now };
      deliveries.set(id, row);
      return { result: "claimed", delivery: structuredClone(row) };
    },
    async finishDelivery(input) {
      const row = deliveries.get(key(input.userId, input.isoWeek));
      if (row?.tenantId === input.tenantId && row.runId === input.runId && row.state === "sending") {
        row.state = input.state; row.updatedAt = input.now;
        row.providerMessageId = input.providerMessageId;
      }
    },
  };
}
export function createMemoryDigestRecipientStore(): DigestRecipientStore {
  const preferences = createMemoryWeeklyDigestStore();
  return {
    async listDigestRecipientPairs(cursor, limit = 1000) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("digest page limit must be 1..1000");
      const items: Array<{ tenantId: string; userId: string }> = [];
      for (const [tenantId, members] of memoryState().members) for (const member of members) {
        if (member.email && await preferences.getPreference(tenantId, member.userId)) items.push({ tenantId, userId: member.userId });
      }
      const encode = (pair: typeof items[number]) => JSON.stringify([pair.tenantId, pair.userId]);
      const page = items.sort((a, b) => encode(a) < encode(b) ? -1 : 1).filter(pair => !cursor || encode(pair) > cursor).slice(0, limit);
      return { items: page, ...(page.length === limit ? { nextCursor: encode(page.at(-1)!) } : {}) };
    },
  };
}
