import { afterAll, beforeAll, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createTestDb, createUser, becomeAppUser, type TestDb } from "./helpers.js";
import { createTenantForUser } from "../src/tenants.js";
import { digestDeliveries, memberships } from "../src/schema/index.js";
import { tenantScoped } from "../src/tenant.js";
import { weeklyDigest } from "../src/weekly-digest.js";
let t: TestDb;
let userId: string;
let tenantId: string;
let otherTenant: string;
beforeAll(async () => {
  t = await createTestDb();
  userId = await createUser(t.db);
  tenantId = (await createTenantForUser(t.db, { userId, name: "A" })).tenantId;
  otherTenant = (await createTenantForUser(t.db, { userId: await createUser(t.db), name: "B" })).tenantId;
  await becomeAppUser(t.client);
});
afterAll(async () => { await t?.close(); });
it("claims an opted-in owner's weekly delivery in tenant scope and resets consent on role change", async () => {
  expect(await weeklyDigest.getPreference(t.db, tenantId, userId)).toBe(true);
  expect(await weeklyDigest.getPreference(t.db, otherTenant, userId)).toBeUndefined();
  const now = new Date("2026-10-05T14:00:00Z");
  const claim = { tenantId, userId, isoWeek: "2026-W41", periodStart: new Date("2026-09-28T14:00:00Z"), periodEnd: now, now, runId: "run-a" };
  expect((await weeklyDigest.claimDelivery(t.db, claim)).result).toBe("claimed");
  expect(await weeklyDigest.getDelivery(t.db, otherTenant, userId, claim.isoWeek)).toBeUndefined();
  await tenantScoped(t.db, tenantId).update(memberships, { role: "member" }, eq(memberships.userId, userId));
  expect(await weeklyDigest.getPreference(t.db, tenantId, userId)).toBe(false);
  await weeklyDigest.setPreference(t.db, tenantId, userId, true);
  expect(await weeklyDigest.getPreference(t.db, tenantId, userId)).toBe(true);
  await weeklyDigest.setPreference(t.db, tenantId, userId, false);
  await tenantScoped(t.db, tenantId).update(memberships, { role: "owner" }, eq(memberships.userId, userId));
  expect(await weeklyDigest.getPreference(t.db, tenantId, userId)).toBe(true);
});
it("resumes the same run, leases other runs, and suppresses hidden household collisions", async () => {
  const now = new Date("2026-10-12T14:00:00Z");
  const claim = { tenantId, userId, isoWeek: "2026-W42", periodStart: new Date("2026-10-05T14:00:00Z"), periodEnd: now, now, runId: "a" };
  expect((await weeklyDigest.claimDelivery(t.db, claim)).result).toBe("claimed");
  expect((await weeklyDigest.claimDelivery(t.db, { ...claim, now: new Date(+now + 1000) })).result).toBe("claimed");
  expect((await weeklyDigest.claimDelivery(t.db, { ...claim, runId: "b", now: new Date(+now + 899999) })).result).toBe("owned_live");
  const takeover = await weeklyDigest.claimDelivery(t.db, { ...claim, runId: "b", now: new Date(+now + 900000) });
  expect(takeover).toMatchObject({ result: "claimed", delivery: { runId: "b", claimedAt: new Date(+now + 900000) } });
  expect((await weeklyDigest.claimDelivery(t.db, { ...claim, tenantId: otherTenant })).result).toBe("household_move_collision");
  await weeklyDigest.finishDelivery(t.db, { ...claim, state: "sent" });
  expect((await weeklyDigest.getDelivery(t.db, tenantId, userId, claim.isoWeek))?.state).toBe("sending");
  await weeklyDigest.finishDelivery(t.db, { ...claim, runId: "b", state: "sent" });
  expect((await weeklyDigest.claimDelivery(t.db, claim)).result).toBe("terminal");
  expect(await weeklyDigest.getDelivery(t.db, otherTenant, userId, claim.isoWeek)).toBeUndefined();
});
it("discovers only opted-in verified pairs with bounded cursor pages and no PUBLIC execute", async () => {
  await t.client.exec("reset role");
  await t.client.exec("UPDATE users SET email_verified = now(); GRANT EXECUTE ON FUNCTION public.list_digest_recipients(uuid,text,integer) TO app_user; SET ROLE app_user;");
  const first = await weeklyDigest.listDigestRecipientPairs(t.db, { limit: 1 });
  expect(first.items).toHaveLength(1);
  expect(Object.keys(first.items[0]!).sort()).toEqual(["tenantId", "userId"]);
  expect(first.nextCursor).toBeTruthy();
  const next = await weeklyDigest.listDigestRecipientPairs(t.db, { cursor: first.nextCursor, limit: 1 });
  expect(next.items).toHaveLength(1);
  expect(next.items[0]).not.toEqual(first.items[0]);
  await expect(weeklyDigest.listDigestRecipientPairs(t.db, { limit: 1001 })).rejects.toThrow();
  const privileges = await t.client.query<{ allowed: boolean }>("select has_function_privilege('public', 'public.list_digest_recipients(uuid,text,integer)', 'execute') as allowed");
  expect(privileges.rows[0]?.allowed).toBe(false);
});

it("enforces ledger RLS on raw cross-tenant reads, updates, and inserts", async () => {
  const now = new Date("2026-10-19T14:00:00Z");
  const claim = {
    tenantId, userId, isoWeek: "2026-W43",
    periodStart: new Date("2026-10-12T14:00:00Z"), periodEnd: now, now, runId: "rls-a",
  };
  expect((await weeklyDigest.claimDelivery(t.db, claim)).result).toBe("claimed");

  const hidden = await tenantScoped(t.db, otherTenant).transaction(async scoped => {
    const role = await scoped.tx.execute(sql`select current_user`);
    expect((role as { rows: { current_user: string }[] }).rows[0]?.current_user).toBe("app_user");
    return scoped.tx.select().from(digestDeliveries).where(eq(digestDeliveries.userId, userId));
  });
  expect(hidden).toHaveLength(0);

  const updated = await tenantScoped(t.db, otherTenant).transaction(async scoped => {
    const role = await scoped.tx.execute(sql`select current_user`);
    expect((role as { rows: { current_user: string }[] }).rows[0]?.current_user).toBe("app_user");
    return scoped.tx.update(digestDeliveries).set({ state: "failed" })
      .where(eq(digestDeliveries.userId, userId)).returning();
  });
  expect(updated).toHaveLength(0);

  await expect(tenantScoped(t.db, otherTenant).transaction(async scoped => {
    const role = await scoped.tx.execute(sql`select current_user`);
    expect((role as { rows: { current_user: string }[] }).rows[0]?.current_user).toBe("app_user");
    await scoped.tx.insert(digestDeliveries).values({
      tenantId, userId, isoWeek: "2026-W44", state: "sending",
      periodStart: now, periodEnd: new Date("2026-10-26T14:00:00Z"),
    });
  })).rejects.toMatchObject({
    cause: expect.objectContaining({
      code: "42501",
      message: expect.stringContaining("new row violates row-level security policy"),
    }),
  });
});
