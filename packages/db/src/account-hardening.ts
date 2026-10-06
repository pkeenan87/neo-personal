import { and, eq, gt, isNull, lte, ne } from "drizzle-orm";
import { isAccountHardeningAnswerAllowed, type AccountHardeningEvidenceId, type AccountHardeningItemId, type AccountHardeningState, type AccountHardeningVersion } from "@neo/core";
import type { Db } from "./client.js";
import { accountHardeningAnswers, devices, inboundMessages } from "./schema/index.js";
import { tenantScoped } from "./tenant.js";

export type { AccountHardeningEvidenceId, AccountHardeningItemId, AccountHardeningState, AccountHardeningVersion };
export interface AccountHardeningAnswer {
  tenantId: string; userId: string; itemId: AccountHardeningItemId;
  value: boolean | "not_applicable"; checklistVersion: AccountHardeningVersion; answeredAt: Date;
}

const FORWARDING_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function answerOf(row: typeof accountHardeningAnswers.$inferSelect): AccountHardeningAnswer {
  return {
    tenantId: row.tenantId, userId: row.userId, itemId: row.itemId as AccountHardeningItemId,
    value: row.notApplicable ? "not_applicable" : (row.answer as boolean),
    checklistVersion: row.checklistVersion as AccountHardeningVersion, answeredAt: row.answeredAt,
  };
}

export const accountHardening = {
  async getAnswers(db: Db, tenantId: string, userId: string): Promise<AccountHardeningAnswer[]> {
    const rows = await tenantScoped(db, tenantId).select(accountHardeningAnswers, eq(accountHardeningAnswers.userId, userId));
    return rows.map(answerOf);
  },
  /** Neo-derived items for one member, from this tenant's records only. Missing rows are known `needs_action`. */
  async getEvidence(db: Db, tenantId: string, userId: string, asOf: Date): Promise<Record<AccountHardeningEvidenceId, "complete" | "needs_action" | "unknown">> {
    return tenantScoped(db, tenantId).transaction(async t => {
      const forwarded = await t.first(inboundMessages, and(
        eq(inboundMessages.forwarderUserId, userId),
        ne(inboundMessages.status, "rejected"), // a rejected message was never analyzed
        gt(inboundMessages.receivedAt, new Date(+asOf - FORWARDING_WINDOW_MS)),
        lte(inboundMessages.receivedAt, asOf),
      ));
      const active = await t.select(devices, and(eq(devices.userId, userId), isNull(devices.revokedAt)));
      const has = (kind: "browser_extension" | "desktop_agent") => active.some(d => d.kind === kind) ? "complete" as const : "needs_action" as const;
      return {
        forwarding_used_30d: forwarded ? "complete" : "needs_action",
        browser_extension_enrolled: has("browser_extension"),
        desktop_agent_enrolled: has("desktop_agent"),
      };
    });
  },
  /** Upsert; `answeredAt` is always server time (`now` is for tests). Throws on a non-answerable item/value. */
  async set(db: Db, answer: Omit<AccountHardeningAnswer, "answeredAt">, now: Date = new Date()): Promise<AccountHardeningAnswer> {
    if (!isAccountHardeningAnswerAllowed(answer.itemId, answer.value)) throw new Error("@neo/db: item is not answerable with this value");
    const values = {
      answer: answer.value === "not_applicable" ? null : answer.value,
      notApplicable: answer.value === "not_applicable",
      checklistVersion: answer.checklistVersion, answeredAt: now,
    };
    return tenantScoped(db, answer.tenantId).transaction(async t => {
      const where = and(eq(accountHardeningAnswers.userId, answer.userId), eq(accountHardeningAnswers.itemId, answer.itemId));
      const [updated] = await t.update(accountHardeningAnswers, values, where);
      if (updated) return answerOf(updated);
      const [inserted] = await t.tx.insert(accountHardeningAnswers)
        .values({ tenantId: answer.tenantId, userId: answer.userId, itemId: answer.itemId, ...values })
        .onConflictDoUpdate({ target: [accountHardeningAnswers.tenantId, accountHardeningAnswers.userId, accountHardeningAnswers.itemId], set: values })
        .returning();
      return answerOf(inserted!);
    });
  },
  async clear(db: Db, tenantId: string, userId: string, itemId: AccountHardeningItemId): Promise<boolean> {
    const rows = await tenantScoped(db, tenantId).delete(accountHardeningAnswers, and(eq(accountHardeningAnswers.userId, userId), eq(accountHardeningAnswers.itemId, itemId)));
    return rows.length > 0;
  },
};
