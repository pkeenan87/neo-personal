// @vitest-environment node
import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestDb, createUser, becomeAppUser, type TestDb } from "../../../packages/db/test/helpers";
import { accountHardening, createTenantForUser, memberships, tenantScoped, verdicts, users } from "@neo/db";
import { createMemoryHardeningStore } from "@/lib/server/memory-hardening";
import { eq } from "drizzle-orm";
import { createDbDigestServices, createMemoryDigestContentStore, resolveMemoryDigestRecipient } from "@/lib/server/weekly-digest/data";
import { resetMemoryState, setMemoryMembers, saveMemoryVerdict, memoryVerdicts } from "@/lib/server/memory-state";
import type { Verdict } from "@neo/verdict";
const verdict: Verdict = { subject_type: "url", verdict: "suspicious", confidence: 0.8, headline: "Risky check", indicators: [], recommended_actions: [], iocs: { urls: [], domains: [], ips: [], hashes: [], phone_numbers: [] } };
const periodStart = new Date("2026-09-28T14:00:00Z");
const periodEnd = new Date("2026-10-05T14:00:00Z");
let testDb: TestDb | undefined;
beforeAll(async () => {
  testDb = await createTestDb();
}, 60_000);
afterAll(async () => {
  await testDb?.close();
});
it("loads digest facts and verified live recipients under app_user tenant scope", async () => {
  const t = testDb!;
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
}, 30_000);
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
it("adds only the recipient's own hardening percentage, omitted until enough answers (DB)", async () => {
  const t = testDb!;
  const owner = await createUser(t.db);
  const tenantId = (await createTenantForUser(t.db, { userId: owner, name: "H" })).tenantId;
  await t.db.update(users).set({ emailVerified: periodStart }).where(eq(users.id, owner));
  const [member] = await t.db.insert(users).values({ name: "M", email: `hm-${Date.now()}@example.test`, emailVerified: periodStart }).returning({ id: users.id });
  await tenantScoped(t.db, tenantId).insert(memberships, { userId: member!.id, role: "member" });
  await becomeAppUser(t.client);
  const services = createDbDigestServices(t.db);
  await services.store.setPreference(tenantId, member!.id, true);
  const ownerInput = { tenantId, userId: owner, role: "owner" as const, periodStart, periodEnd };
  expect((await services.content.loadDigestContent(ownerInput)).hardeningScore).toBeUndefined();
  for (const itemId of ["primary_email_2fa", "passkey_or_hardware_key", "password_manager"] as const) {
    await accountHardening.set(t.db, { tenantId, userId: member!.id, itemId, value: true, checklistVersion: "account-hardening-v1" });
  }
  expect((await services.content.loadDigestContent(ownerInput)).hardeningScore).toBeUndefined(); // the member's score is not the owner's
  const content = await services.content.loadDigestContent({ ...ownerInput, userId: member!.id, role: "member" });
  expect(content.hardeningScore).toEqual({ scorePercent: 45, href: "/settings/hardening" });
  expect(Object.keys(content)).toEqual(["hardeningScore"]);
}, 30_000);
it("adds the hardening percentage to the in-memory digest content too", async () => {
  resetMemoryState();
  const tenantId = "11111111-1111-4111-8111-111111111111";
  setMemoryMembers(tenantId, [{ userId: "mock-user", role: "owner", name: "Name", email: "synthetic@example.test" }]);
  const store = createMemoryHardeningStore();
  for (const itemId of ["primary_email_2fa", "passkey_or_hardware_key", "password_manager"] as const) {
    await store.set({ tenantId, userId: "mock-user", itemId, value: itemId !== "password_manager", checklistVersion: "account-hardening-v1" });
  }
  const content = await createMemoryDigestContentStore().loadDigestContent({ tenantId, userId: "mock-user", role: "owner", periodStart, periodEnd });
  expect(content.hardeningScore).toEqual({ scorePercent: 30, href: "/settings/hardening" });
});
