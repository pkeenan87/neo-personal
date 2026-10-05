// @vitest-environment node
import { expect, it } from "vitest";
import { createTestDb, createUser, becomeAppUser } from "../../../packages/db/test/helpers";
import { createTenantForUser, tenantScoped, verdicts, users } from "@neo/db";
import { eq } from "drizzle-orm";
import { createDbDigestServices, createMemoryDigestContentStore, resolveMemoryDigestRecipient } from "@/lib/server/weekly-digest/data";
import { resetMemoryState, setMemoryMembers, saveMemoryVerdict, memoryVerdicts } from "@/lib/server/memory-state";
import type { Verdict } from "@neo/verdict";
const verdict: Verdict = { subject_type: "url", verdict: "suspicious", confidence: 0.8, headline: "Risky check", indicators: [], recommended_actions: [], iocs: { urls: [], domains: [], ips: [], hashes: [], phone_numbers: [] } };
const periodStart = new Date("2026-09-28T14:00:00Z");
const periodEnd = new Date("2026-10-05T14:00:00Z");
it("loads digest facts and verified live recipients under app_user tenant scope", async () => {
  const t = await createTestDb();
  try {
    const userId = await createUser(t.db);
    const tenantId = (await createTenantForUser(t.db, { userId, name: "A" })).tenantId;
    const stranger = await createUser(t.db);
    const other = (await createTenantForUser(t.db, { userId: stranger, name: "B" })).tenantId;
    await t.db.update(users).set({ emailVerified: periodStart }).where(eq(users.id, userId));
    await becomeAppUser(t.client);
    await tenantScoped(t.db, tenantId).insert(verdicts, { userId, source: "chat", subjectType: "url", verdict: "suspicious", confidence: 0.8, headline: "Risky check", body: { secret: "NEVER SELECT BODY" }, createdAt: periodStart });
    const services = createDbDigestServices(t.db);
    expect(await services.resolveRecipient(tenantId, userId)).toMatchObject({ userId, role: "owner" });
    expect(await services.resolveRecipient(other, userId)).toBeUndefined();
    expect(await services.resolveRecipient(other, stranger)).toBeUndefined();
    const content = await services.content.loadDigestContent({ tenantId, userId, role: "owner", periodStart, periodEnd });
    expect(content.personal?.topVerdicts).toHaveLength(1);
    expect(JSON.stringify(content)).not.toContain("NEVER SELECT BODY");
    expect(await services.content.loadDigestContent({ tenantId: other, userId, role: "owner", periodStart, periodEnd })).toEqual({});
    await services.store.setPreference(tenantId, userId, false);
    expect(await services.resolveRecipient(tenantId, userId)).toBeUndefined();
  } finally { await t.close(); }
});
it("uses existing mock verdicts and live memberships", async () => {
  resetMemoryState();
  const tenantId = "11111111-1111-4111-8111-111111111111";
  const userId = "mock-user";
  setMemoryMembers(tenantId, [{ userId, role: "owner", name: "Name", email: "synthetic@example.test" }]);
  saveMemoryVerdict({ tenantId, userId, source: "chat", verdict });
  memoryVerdicts()[0]!.createdAt = periodStart;
  expect(await resolveMemoryDigestRecipient(tenantId, userId)).toMatchObject({ userId, role: "owner" });
  const input = { tenantId, userId, role: "owner" as const, periodStart, periodEnd };
  expect((await createMemoryDigestContentStore().loadDigestContent(input)).personal?.topVerdicts).toHaveLength(1);
  setMemoryMembers(tenantId, []);
  expect(await resolveMemoryDigestRecipient(tenantId, userId)).toBeUndefined();
  expect(await createMemoryDigestContentStore().loadDigestContent(input)).toEqual({});
});
