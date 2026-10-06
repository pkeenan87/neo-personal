/**
 * In-memory account-hardening store when DATABASE_URL is unset (MOCK_MODE, tests). Mirrors
 * @neo/db account-hardening.ts: per-user answers keyed by item, server-set `answeredAt`, and the
 * same evidence rules (attributed forwards in the rolling 30 days; active devices of a kind).
 * Answers are removed with the membership (memory-state.ts `setMemoryMembers`).
 */
import { isAccountHardeningAnswerAllowed } from "@neo/core";
import type { AccountHardeningAnswer } from "@neo/db";
import { memoryListDevices } from "./memory-devices";
import { memoryListMembers, memoryState } from "./memory-state";
import type { HardeningStore } from "./hardening-score";

const FORWARDING_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const key = (tenantId: string, userId: string, itemId: string) => `${tenantId}:${userId}:${itemId}`;

export function createMemoryHardeningStore(): HardeningStore {
  const answers = () => memoryState().hardeningAnswers;
  return {
    async getAnswers(tenantId, userId) {
      return [...answers().values()].filter(a => a.tenantId === tenantId && a.userId === userId).map(a => ({ ...a }));
    },
    async getEvidence(tenantId, userId, asOf) {
      const forwarded = memoryState().inboundMessages.some(m => m.tenantId === tenantId && m.forwarderUserId === userId && m.status !== "rejected"
        && +m.receivedAt > +asOf - FORWARDING_WINDOW_MS && +m.receivedAt <= +asOf);
      const devices = memoryListDevices(tenantId, { userId });
      const has = (kind: "browser_extension" | "desktop_agent") => devices.some(d => d.kind === kind) ? "complete" as const : "needs_action" as const;
      return {
        forwarding_used_30d: forwarded ? "complete" : "needs_action",
        browser_extension_enrolled: has("browser_extension"),
        desktop_agent_enrolled: has("desktop_agent"),
      };
    },
    async set(answer, now = new Date()) {
      if (!isAccountHardeningAnswerAllowed(answer.itemId, answer.value)) throw new Error("item is not answerable with this value");
      const member = memoryListMembers(answer.tenantId).some(m => m.userId === answer.userId);
      if (!member) throw Object.assign(new Error("no membership"), { code: "23503" }); // like the foreign key
      const row: AccountHardeningAnswer = { ...answer, answeredAt: now };
      answers().set(key(answer.tenantId, answer.userId, answer.itemId), row);
      return { ...row };
    },
    async clear(tenantId, userId, itemId) {
      return answers().delete(key(tenantId, userId, itemId));
    },
  };
}
