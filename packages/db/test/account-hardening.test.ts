import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountHardening } from "../src/account-hardening.js";
import { leaveHousehold } from "../src/household.js";
import { accountHardeningAnswers, devices, inboundAddresses, inboundMessages, memberships, users } from "../src/schema/index.js";
import { tenantScoped, tenantTables } from "../src/tenant.js";
import { createTenantForUser } from "../src/tenants.js";
import { becomeAppUser, createTestDb, createUser, type TestDb } from "./helpers.js";

const DAY = 24 * 60 * 60 * 1000;
const V1 = "account-hardening-v1" as const;
let t: TestDb;
let ownerA: string;
let tenantA: string;
let memberA: string;
let ownerB: string;
let tenantB: string;
let addressA: string;
let seq = 0;

async function addMember(tenantId: string): Promise<string> {
  seq += 1;
  const [row] = await t.db.insert(users).values({ name: "M", email: `hm${seq}-${Date.now()}@example.test` }).returning({ id: users.id });
  await tenantScoped(t.db, tenantId).insert(memberships, { userId: row!.id, role: "member" });
  return row!.id;
}
async function forward(tenantId: string, addressId: string, forwarderUserId: string | null, receivedAt: Date, status: "done" | "failed" | "received" | "rejected" = "done") {
  seq += 1;
  await tenantScoped(t.db, tenantId).insert(inboundMessages, { addressId, providerMessageId: `pm-${seq}-${Date.now()}`, fromAddressHash: "h", forwarderUserId, status, receivedAt });
}
async function device(tenantId: string, userId: string, kind: "browser_extension" | "desktop_agent", revokedAt: Date | null = null) {
  await tenantScoped(t.db, tenantId).insert(devices, { userId, kind, platform: kind === "desktop_agent" ? "windows" : "chrome", name: "d", clientVersion: "1", enrollment: "self", revokedAt });
}

beforeAll(async () => {
  t = await createTestDb({ createAppUserBeforeMigrations: true });
  const grants = await t.client.query<{ ok: boolean }>(
    `SELECT bool_and(has_table_privilege('app_user', 'public.account_hardening_answers', p)) AS ok FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p`,
  );
  expect(grants.rows[0]?.ok).toBe(true);
  ownerA = await createUser(t.db);
  tenantA = (await createTenantForUser(t.db, { userId: ownerA, name: "A" })).tenantId;
  memberA = await addMember(tenantA);
  ownerB = await createUser(t.db);
  tenantB = (await createTenantForUser(t.db, { userId: ownerB, name: "B" })).tenantId;
  const [addr] = await tenantScoped(t.db, tenantA).insert(inboundAddresses, { localPart: "check-0123456789ab" });
  addressA = addr!.id;
  await becomeAppUser(t.client);
}, 60_000);
afterAll(async () => { await t?.close(); });

describe("account hardening answers (PGlite as app_user)", () => {
  it("is registered as a tenant table with RLS enabled", async () => {
    expect(tenantTables.accountHardeningAnswers).toBe(accountHardeningAnswers);
    const r = await t.client.query<{ relrowsecurity: boolean }>(`select relrowsecurity from pg_class where relname = 'account_hardening_answers'`);
    expect(r.rows[0]?.relrowsecurity).toBe(true);
  });

  it("upserts per user and item, persisting value, version and server time", async () => {
    const at = new Date("2026-10-01T10:00:00Z");
    const a = await accountHardening.set(t.db, { tenantId: tenantA, userId: memberA, itemId: "primary_email_2fa", value: true, checklistVersion: V1 }, at);
    expect(a).toEqual({ tenantId: tenantA, userId: memberA, itemId: "primary_email_2fa", value: true, checklistVersion: V1, answeredAt: at });
    const later = new Date("2026-10-02T10:00:00Z");
    await accountHardening.set(t.db, { tenantId: tenantA, userId: memberA, itemId: "primary_email_2fa", value: false, checklistVersion: V1 }, later);
    await accountHardening.set(t.db, { tenantId: tenantA, userId: memberA, itemId: "credit_freeze", value: "not_applicable", checklistVersion: V1 }, at);
    await accountHardening.set(t.db, { tenantId: tenantA, userId: ownerA, itemId: "primary_email_2fa", value: true, checklistVersion: V1 }, at);
    const mine = await accountHardening.getAnswers(t.db, tenantA, memberA);
    expect(mine.map(x => [x.itemId, x.value, +x.answeredAt]).sort()).toEqual([
      ["credit_freeze", "not_applicable", +at], ["primary_email_2fa", false, +later],
    ]);
    expect(await accountHardening.getAnswers(t.db, tenantA, ownerA)).toHaveLength(1);
  });

  it("rejects non-answerable items and N/A outside the three exceptions", async () => {
    const base = { tenantId: tenantA, userId: memberA, checklistVersion: V1 } as const;
    await expect(accountHardening.set(t.db, { ...base, itemId: "forwarding_used_30d", value: true })).rejects.toThrow();
    await expect(accountHardening.set(t.db, { ...base, itemId: "desktop_agent_enrolled", value: true })).rejects.toThrow();
    await expect(accountHardening.set(t.db, { ...base, itemId: "password_manager", value: "not_applicable" })).rejects.toThrow();
    await expect(accountHardening.set(t.db, { ...base, itemId: "password_manager", value: "yes" as unknown as boolean })).rejects.toThrow();
    await accountHardening.set(t.db, { ...base, itemId: "desktop_agent_enrolled", value: "not_applicable" });
    expect(await accountHardening.clear(t.db, tenantA, memberA, "desktop_agent_enrolled")).toBe(true);
  });

  it("clears one answer and reports whether a row existed", async () => {
    expect(await accountHardening.clear(t.db, tenantA, memberA, "credit_freeze")).toBe(true);
    expect(await accountHardening.clear(t.db, tenantA, memberA, "credit_freeze")).toBe(false);
    expect((await accountHardening.getAnswers(t.db, tenantA, memberA)).map(x => x.itemId)).toEqual(["primary_email_2fa"]);
  });

  it("isolates tenants: other-tenant reads, writes and clears see nothing, and RLS hides rows", async () => {
    expect(await accountHardening.getAnswers(t.db, tenantB, memberA)).toEqual([]);
    expect(await accountHardening.clear(t.db, tenantB, memberA, "primary_email_2fa")).toBe(false);
    // A membership in another tenant is required by the FK.
    await expect(accountHardening.set(t.db, { tenantId: tenantB, userId: memberA, itemId: "password_manager", value: true, checklistVersion: V1 })).rejects.toThrow();
    await t.client.exec(`select set_config('app.tenant_id', '${tenantB}', false)`);
    expect((await t.client.query(`select 1 from account_hardening_answers`)).rows).toEqual([]);
    await t.client.exec(`select set_config('app.tenant_id', '', false)`);
    expect((await t.client.query(`select 1 from account_hardening_answers`)).rows).toEqual([]);
  });

  it("deletes a member's answers when the membership goes away", async () => {
    const leaver = await addMember(tenantA);
    await accountHardening.set(t.db, { tenantId: tenantA, userId: leaver, itemId: "password_manager", value: true, checklistVersion: V1 });
    expect(await accountHardening.getAnswers(t.db, tenantA, leaver)).toHaveLength(1);
    const r = await leaveHousehold(t.db, { tenantId: tenantA, userId: leaver });
    expect(r.status).toBe("left");
    expect(await tenantScoped(t.db, tenantA).select(accountHardeningAnswers, eq(accountHardeningAnswers.userId, leaver))).toEqual([]);
    // Removing the row directly cascades too.
    await accountHardening.set(t.db, { tenantId: tenantB, userId: ownerB, itemId: "password_manager", value: true, checklistVersion: V1 });
    await tenantScoped(t.db, tenantB).delete(memberships, and(eq(memberships.userId, ownerB)));
    expect(await accountHardening.getAnswers(t.db, tenantB, ownerB)).toEqual([]);
  });
});

describe("account hardening evidence", () => {
  const asOf = new Date("2026-10-05T12:00:00Z");
  it("is needs_action for everything when a working store has no rows", async () => {
    const ev = await accountHardening.getEvidence(t.db, tenantA, memberA, asOf);
    expect(ev).toEqual({ forwarding_used_30d: "needs_action", browser_extension_enrolled: "needs_action", desktop_agent_enrolled: "needs_action" });
  });

  it("counts only this user's attributed forwards inside the rolling 30 days", async () => {
    await forward(tenantA, addressA, null, new Date(+asOf - DAY)); // stuck/unattributed
    await forward(tenantA, addressA, ownerA, new Date(+asOf - DAY)); // another member
    expect((await accountHardening.getEvidence(t.db, tenantA, memberA, asOf)).forwarding_used_30d).toBe("needs_action");
    await forward(tenantA, addressA, memberA, new Date(+asOf - 30 * DAY)); // exactly 30 days: out of window
    expect((await accountHardening.getEvidence(t.db, tenantA, memberA, asOf)).forwarding_used_30d).toBe("needs_action");
    await forward(tenantA, addressA, memberA, new Date(+asOf - DAY), "rejected"); // rejected never counts
    expect((await accountHardening.getEvidence(t.db, tenantA, memberA, asOf)).forwarding_used_30d).toBe("needs_action");
    await forward(tenantA, addressA, memberA, new Date(+asOf - 30 * DAY + 1), "failed"); // failed analysis still counts
    expect((await accountHardening.getEvidence(t.db, tenantA, memberA, asOf)).forwarding_used_30d).toBe("complete");
    expect((await accountHardening.getEvidence(t.db, tenantA, memberA, new Date(+asOf + 2 * DAY))).forwarding_used_30d).toBe("needs_action");
    expect((await accountHardening.getEvidence(t.db, tenantB, memberA, asOf)).forwarding_used_30d).toBe("needs_action");
  });

  it("counts active devices of the matching kind for this user only; revoked do not count", async () => {
    await device(tenantA, memberA, "browser_extension", new Date());
    await device(tenantA, ownerA, "desktop_agent");
    expect(await accountHardening.getEvidence(t.db, tenantA, memberA, asOf)).toMatchObject({ browser_extension_enrolled: "needs_action", desktop_agent_enrolled: "needs_action" });
    await device(tenantA, memberA, "browser_extension");
    await device(tenantA, memberA, "desktop_agent", new Date());
    expect(await accountHardening.getEvidence(t.db, tenantA, memberA, asOf)).toMatchObject({ browser_extension_enrolled: "complete", desktop_agent_enrolled: "needs_action" });
    await device(tenantA, memberA, "desktop_agent");
    expect((await accountHardening.getEvidence(t.db, tenantA, memberA, asOf)).desktop_agent_enrolled).toBe("complete");
    expect((await accountHardening.getEvidence(t.db, tenantB, memberA, asOf)).desktop_agent_enrolled).toBe("needs_action");
  });
});
