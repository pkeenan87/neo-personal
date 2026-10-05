import { afterAll, beforeAll, expect, it } from "vitest";
import { deriveKey, encryptArtifact } from "@neo/core";
import { eq, sql } from "drizzle-orm";
import { createTestDb, createUser, becomeAppUser, type TestDb } from "./helpers.js";
import { createTenantForUser } from "../src/tenants.js";
import { digestDeliveries, memberships, users } from "../src/schema/index.js";
import { tenantScoped } from "../src/tenant.js";
import { weeklyDigest } from "../src/weekly-digest.js";
let t: TestDb;
let userId: string;
let otherUserId: string;
let tenantId: string;
let otherTenant: string;
beforeAll(async () => {
  t = await createTestDb({ createAppUserBeforeMigrations: true });
  const grants = await t.client.query<{ digestSelect: boolean; digestInsert: boolean; digestUpdate: boolean; digestDelete: boolean; recipientExecute: boolean; payloadSweepExecute: boolean }>(
    `SELECT
      has_table_privilege('app_user', 'public.digest_deliveries', 'SELECT') AS "digestSelect",
      has_table_privilege('app_user', 'public.digest_deliveries', 'INSERT') AS "digestInsert",
      has_table_privilege('app_user', 'public.digest_deliveries', 'UPDATE') AS "digestUpdate",
      has_table_privilege('app_user', 'public.digest_deliveries', 'DELETE') AS "digestDelete",
      has_function_privilege('app_user', 'public.list_digest_recipients(uuid,text,integer)', 'EXECUTE') AS "recipientExecute",
      has_function_privilege('app_user', 'public.purge_weekly_digest_payloads(timestamptz)', 'EXECUTE') AS "payloadSweepExecute"`,
  );
  expect(grants.rows[0]).toEqual({ digestSelect: true, digestInsert: true, digestUpdate: true, digestDelete: true, recipientExecute: true, payloadSweepExecute: true });
  userId = await createUser(t.db);
  tenantId = (await createTenantForUser(t.db, { userId, name: "A" })).tenantId;
  otherUserId = await createUser(t.db);
  otherTenant = (await createTenantForUser(t.db, { userId: otherUserId, name: "B" })).tenantId;
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
  await t.client.exec("UPDATE users SET email_verified = now(); SET ROLE app_user;");
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

it("excludes unverified, opted-out owners, and default-off members from recipient discovery", async () => {
  await t.client.exec("reset role");
  const verifiedAt = new Date("2026-10-05T14:00:00Z");
  const optedOutUser = await createUser(t.db, "Opted Out");
  const optedOutTenant = (await createTenantForUser(t.db, { userId: optedOutUser, name: "Opted Out" })).tenantId;
  await t.db.update(users).set({ emailVerified: verifiedAt }).where(eq(users.id, optedOutUser));
  await weeklyDigest.setPreference(t.db, optedOutTenant, optedOutUser, false);

  const unverifiedUser = await createUser(t.db, "Unverified");
  const unverifiedTenant = (await createTenantForUser(t.db, { userId: unverifiedUser, name: "Unverified" })).tenantId;

  const memberId = await createUser(t.db, "Default Member");
  await t.db.update(users).set({ emailVerified: verifiedAt }).where(eq(users.id, memberId));
  await t.db.insert(memberships).values({ tenantId, userId: memberId, role: "member" });
  const [memberPreference] = await t.db.select({ enabled: memberships.weeklyDigestEnabled }).from(memberships)
    .where(eq(memberships.userId, memberId));
  expect(memberPreference?.enabled).toBe(false);

  await t.client.exec("SET ROLE app_user");
  const all = await weeklyDigest.listDigestRecipientPairs(t.db, { limit: 1000 });
  const pairs = all.items.map(pair => `${pair.tenantId}:${pair.userId}`);
  expect(pairs.sort()).toEqual([`${tenantId}:${userId}`, `${otherTenant}:${otherUserId}`].sort());
  expect(pairs).not.toContain(`${optedOutTenant}:${optedOutUser}`);
  expect(pairs).not.toContain(`${unverifiedTenant}:${unverifiedUser}`);
  expect(pairs).not.toContain(`${tenantId}:${memberId}`);
  const grant = await t.client.query<{ allowed: boolean }>("select has_function_privilege('app_user', 'public.list_digest_recipients(uuid,text,integer)', 'execute') as allowed");
  expect(grant.rows[0]?.allowed).toBe(true);
});

it("enforces ledger RLS on raw cross-tenant reads, updates, and inserts", async () => {
  const now = new Date("2026-10-19T14:00:00Z");
  const claim = {
    tenantId, userId, isoWeek: "2026-W43",
    periodStart: new Date("2026-10-12T14:00:00Z"), periodEnd: now, now, runId: "rls-a",
  };
  expect((await weeklyDigest.claimDelivery(t.db, claim)).result).toBe("claimed");
  const ciphertext = new Uint8Array([1, 2, 3, 4, 255]);
  expect(await weeklyDigest.savePayload(t.db, { ...claim, payload: ciphertext })).toBe(true);
  expect(await weeklyDigest.getPayload(t.db, claim)).toEqual(ciphertext);
  expect(await weeklyDigest.getDelivery(t.db, tenantId, userId, claim.isoWeek)).not.toHaveProperty("payload");

  const hidden = await tenantScoped(t.db, otherTenant).transaction(async scoped => {
    const role = await scoped.tx.execute(sql`select current_user`);
    expect((role as { rows: { current_user: string }[] }).rows[0]?.current_user).toBe("app_user");
    return scoped.tx.select({ payload: digestDeliveries.payload }).from(digestDeliveries).where(eq(digestDeliveries.userId, userId));
  });
  expect(hidden).toHaveLength(0);

  const updated = await tenantScoped(t.db, otherTenant).transaction(async scoped => {
    const role = await scoped.tx.execute(sql`select current_user`);
    expect((role as { rows: { current_user: string }[] }).rows[0]?.current_user).toBe("app_user");
    return scoped.tx.update(digestDeliveries).set({ state: "failed", payload: null })
      .where(eq(digestDeliveries.userId, userId)).returning();
  });
  expect(updated).toHaveLength(0);

  await expect(tenantScoped(t.db, otherTenant).transaction(async scoped => {
    const role = await scoped.tx.execute(sql`select current_user`);
    expect((role as { rows: { current_user: string }[] }).rows[0]?.current_user).toBe("app_user");
    await scoped.tx.insert(digestDeliveries).values({
      tenantId, userId, isoWeek: "2026-W44", state: "sending",
      periodStart: now, periodEnd: new Date("2026-10-26T14:00:00Z"), payload: ciphertext,
    });
  })).rejects.toMatchObject({
    cause: expect.objectContaining({
      code: "42501",
      message: expect.stringContaining("new row violates row-level security policy"),
    }),
  });
  await weeklyDigest.finishDelivery(t.db, { ...claim, state: "sent", now: new Date(+now + 1) });
  expect(await weeklyDigest.getPayload(t.db, claim)).toBeUndefined();
});

it("clears a sending payload after the 24-hour retention window", async () => {
  const now = new Date("2026-10-26T14:00:00Z");
  const claim = {
    tenantId, userId, isoWeek: "2026-W44",
    periodStart: new Date("2026-10-19T14:00:00Z"), periodEnd: now, now, runId: "sweep-a",
  };
  expect((await weeklyDigest.claimDelivery(t.db, claim)).result).toBe("claimed");
  const payload = encryptArtifact(
    deriveKey(new Uint8Array(32).fill(7), "neo-weekly-digest-payload-v1", tenantId),
    new TextEncoder().encode("synthetic weekly digest payload"),
    `digest:${tenantId}:${userId}:2026-W44`,
  );
  expect(await weeklyDigest.savePayload(t.db, { ...claim, payload })).toBe(true);
  const takeover = { ...claim, runId: "sweep-b", now: new Date(+now + 23 * 60 * 60_000) };
  expect((await weeklyDigest.claimDelivery(t.db, takeover)).result).toBe("claimed");
  expect(await weeklyDigest.getPayload(t.db, takeover)).toEqual(payload);
  expect(await weeklyDigest.purgeStalePayloads(t.db, new Date(+now + 24 * 60 * 60_000))).toBe(1);
  expect(await weeklyDigest.getPayload(t.db, takeover)).toBeUndefined();
});
