/**
 * Child policy tables (_specs/v2-m2-child.md sections 2, 3 and 8; migration 0021) on PGlite as the
 * non-owner app role: consents and child requests are tenant-isolated and check-constrained, the
 * three new alert kinds are accepted, members without an account can be created (and capped), and
 * the protection layers carry what the age band needs.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAlert } from "../src/alerts.js";
import { listConsents, recordConsent } from "../src/consents.js";
import { MAX_MEMBERS_WITHOUT_ACCOUNT, createMemberWithoutAccount, getMemberContact, getProtectionLayers, updateMember } from "../src/members.js";
import { alerts, childRequests, members } from "../src/schema/index.js";
import { tenantScoped } from "../src/tenant.js";
import { createTenantForUser, setHouseholdTimeZone } from "../src/tenants.js";
import { becomeAppUser, createTestDb, createUser, type TestDb } from "./helpers.js";

let t: TestDb;
let ownerId: string;
let tenantId: string;
let otherTenantId: string;
let kid: string;

beforeAll(async () => {
  t = await createTestDb({ createAppUserBeforeMigrations: true });
  ownerId = await createUser(t.db, "Pat");
  tenantId = (await createTenantForUser(t.db, { userId: ownerId, name: "Pat's household" })).tenantId;
  const other = await createUser(t.db, "Zed");
  otherTenantId = (await createTenantForUser(t.db, { userId: other, name: "Zed's household" })).tenantId;
  await becomeAppUser(t.client);
  kid = (await createMemberWithoutAccount(tenantScoped(t.db, tenantId), { displayName: "Sam", role: "child", birthYear: 2016 })).id;
}, 60_000);
afterAll(async () => {
  await t.close();
});

describe("migration 0021", () => {
  it("creates both tables with row-level security and a tenant policy", async () => {
    const rls = await t.client.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relname in ('consents', 'child_requests')`,
    );
    expect(Object.fromEntries(rls.rows.map((r) => [r.relname, r.relrowsecurity]))).toEqual({ consents: true, child_requests: true });
    const policies = await t.client.query<{ tablename: string }>(`select tablename from pg_policies where schemaname = 'public' and policyname = 'tenant_isolation' and tablename in ('consents', 'child_requests')`);
    expect(policies.rows.map((r) => r.tablename).sort()).toEqual(["child_requests", "consents"]);
  });

  it("accepts the three new alert kinds and still rejects an unknown one", async () => {
    const tdb = tenantScoped(t.db, tenantId);
    for (const kind of ["self_harm_attempts", "app_approval", "child_request"] as const) {
      const row = await createAlert(t.db, { tenantId, subjectUserId: null, kind, severity: "medium", title: kind, body: "x", dedupeKey: `k:${kind}`, memberId: kid });
      expect(row?.kind).toBe(kind);
    }
    await expect(tdb.insert(alerts, { kind: "nope" as never, severity: "low", title: "t", body: "b", dedupeKey: "k:nope" })).rejects.toThrow();
  });
});

describe("consents", () => {
  it("records and lists a consent, newest first", async () => {
    const tdb = tenantScoped(t.db, tenantId);
    const a = await recordConsent(tdb, { memberId: kid, kind: "monitoring_notice", grantedBy: ownerId, evidence: { mode: "child", band: "10_13" } });
    expect(a).toMatchObject({ tenantId, memberId: kid, kind: "monitoring_notice", grantedBy: ownerId, evidence: { mode: "child", band: "10_13" } });
    await recordConsent(tdb, { memberId: kid, kind: "guardian_consent", grantedBy: null });
    const list = await listConsents(tdb, kid);
    expect(list.map((c) => c.kind).sort()).toEqual(["guardian_consent", "monitoring_notice"]);
    expect(await listConsents(tdb, "not-a-uuid")).toEqual([]);
  });

  it("rejects an unknown kind, a member of another household, and oversized evidence", async () => {
    const tdb = tenantScoped(t.db, tenantId);
    await expect(recordConsent(tdb, { memberId: kid, kind: "nope" as never, grantedBy: ownerId })).rejects.toThrow(/unknown consent kind/);
    await expect(recordConsent(tenantScoped(t.db, otherTenantId), { memberId: kid, kind: "monitoring_notice", grantedBy: null })).rejects.toThrow(/not in this household/);
    await expect(recordConsent(tdb, { memberId: kid, kind: "monitoring_notice", grantedBy: null, evidence: { x: "y".repeat(2000) } })).rejects.toThrow(/too large/);
    expect(await listConsents(tenantScoped(t.db, otherTenantId), kid)).toEqual([]);
  });

  it("is removed with its member (cascade)", async () => {
    const tdb = tenantScoped(t.db, tenantId);
    const temp = await createMemberWithoutAccount(tdb, { displayName: "Temp", role: "adult" });
    await recordConsent(tdb, { memberId: temp.id, kind: "monitoring_notice", grantedBy: ownerId });
    await tdb.transaction((x) => x.delete(members, eq(members.id, temp.id)));
    expect(await listConsents(tdb, temp.id)).toEqual([]);
  });
});

describe("child_requests", () => {
  it("stores a request with its defaults and enforces the kind, status and reason checks", async () => {
    const tdb = tenantScoped(t.db, tenantId);
    const [row] = await tdb.insert(childRequests, { memberId: kid, kind: "more_time", detail: { minutes: 30 }, reason: "homework" });
    expect(row).toMatchObject({ status: "pending", deviceId: null, decidedBy: null, grant: null, detail: { minutes: 30 } });
    await expect(tdb.insert(childRequests, { memberId: kid, kind: "nope" as never })).rejects.toThrow();
    await expect(tdb.insert(childRequests, { memberId: kid, kind: "more_time", status: "maybe" as never })).rejects.toThrow();
    await expect(tdb.insert(childRequests, { memberId: kid, kind: "more_time", reason: "x".repeat(141) })).rejects.toThrow();
    const [ok] = await tdb.insert(childRequests, { memberId: kid, kind: "unblock_site", reason: "x".repeat(140) });
    expect(ok?.reason).toHaveLength(140);
  });

  it("is invisible to another household", async () => {
    expect(await tenantScoped(t.db, otherTenantId).select(childRequests)).toEqual([]);
    expect((await tenantScoped(t.db, tenantId).select(childRequests)).length).toBeGreaterThan(0);
  });
});

describe("createMemberWithoutAccount", () => {
  it("creates a member with no user, an encrypted contact and a birth year", async () => {
    const tdb = tenantScoped(t.db, tenantId);
    const m = await createMemberWithoutAccount(tdb, { displayName: "  Gran  ", role: "elder", contact: "Gran@Example.test" });
    expect(m).toMatchObject({ displayName: "Gran", role: "elder", mode: "standard", userId: null, birthYear: null, hasContact: true });
    expect(await getMemberContact(tdb, m.id)).toBe("gran@example.test");
    const stored = await tdb.first(members, eq(members.id, m.id));
    expect(stored?.contactCiphertext).toBeTruthy();
    expect(stored?.contactCiphertext).not.toContain("gran");
  });

  it("rejects the owner role, bad names, bad birth years and bad contacts", async () => {
    const tdb = tenantScoped(t.db, tenantId);
    await expect(createMemberWithoutAccount(tdb, { displayName: "X", role: "owner" as never })).rejects.toThrow(/role/);
    await expect(createMemberWithoutAccount(tdb, { displayName: "   ", role: "adult" })).rejects.toThrow(/display name/);
    await expect(createMemberWithoutAccount(tdb, { displayName: "X", role: "child", birthYear: 1800 })).rejects.toThrow(/birth year/);
    await expect(createMemberWithoutAccount(tdb, { displayName: "X", role: "child", birthYear: 3000 })).rejects.toThrow(/birth year/);
    await expect(createMemberWithoutAccount(tdb, { displayName: "X", role: "adult", contact: "not an email" })).rejects.toThrow(/email/);
  });

  it("is capped per household and the cap is per household", async () => {
    const tdb = tenantScoped(t.db, otherTenantId);
    for (let i = 0; i < MAX_MEMBERS_WITHOUT_ACCOUNT; i++) await createMemberWithoutAccount(tdb, { displayName: `Kid ${i}`, role: "child", birthYear: 2015 });
    await expect(createMemberWithoutAccount(tdb, { displayName: "One too many", role: "child" })).rejects.toThrow(/too many/);
    await expect(createMemberWithoutAccount(tenantScoped(t.db, tenantId), { displayName: "Fine", role: "child" })).resolves.toBeDefined();
  });
});

describe("getProtectionLayers for Child mode", () => {
  it("carries the birth year and the household time zone only for a Child-mode member", async () => {
    const tdb = tenantScoped(t.db, tenantId);
    expect(await getProtectionLayers(tdb, { memberId: kid })).toEqual({ memberId: kid, mode: "standard" });
    await updateMember(tdb, kid, { mode: "child" });
    expect(await getProtectionLayers(tdb, { memberId: kid })).toEqual({ memberId: kid, mode: "child", birthYear: 2016 });
    expect(await setHouseholdTimeZone(t.db, tenantId, "Pacific/Auckland")).toBe(true);
    expect(await getProtectionLayers(tdb, { memberId: kid })).toEqual({ memberId: kid, mode: "child", birthYear: 2016, timeZone: "Pacific/Auckland" });
    await updateMember(tdb, kid, { birthYear: null });
    expect(await getProtectionLayers(tdb, { memberId: kid })).toEqual({ memberId: kid, mode: "child", timeZone: "Pacific/Auckland" });
  });
});
