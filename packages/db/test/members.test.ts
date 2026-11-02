/** v2 members, policies and migration 0017 on PGlite, as the non-owner app role. */
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acknowledgeAlert, createAlert } from "../src/alerts.js";
import { createEnrollmentCode } from "../src/devices.js";
import { acceptHouseholdInvite, createHouseholdInvite, leaveHousehold } from "../src/household.js";
import {
  createMemberForUser,
  decryptContact,
  defaultDisplayName,
  deleteMemberForUser,
  encryptContact,
  getMember,
  getMemberByUserId,
  getMemberContact,
  getProtectionLayers,
  insertPolicyVersion,
  listMembers,
  memberRoleForMembership,
  normalizeContact,
  normalizeDisplayName,
  updateMember,
} from "../src/members.js";
import * as schema from "../src/schema/index.js";
import { deviceEnrollmentCodes, devices, members } from "../src/schema/index.js";
import { tenantScoped } from "../src/tenant.js";
import { createTenantForUser } from "../src/tenants.js";
import { becomeAppUser, createTestDb, createUser, type TestDb } from "./helpers.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

describe("pure helpers", () => {
  it("derives display names", () => {
    expect(defaultDisplayName({ name: "  Pat ", email: "p@x.test" })).toBe("Pat");
    expect(defaultDisplayName({ name: null, email: "grandma@x.test" })).toBe("grandma");
    expect(defaultDisplayName({ name: "", email: null })).toBe("Member");
    expect(defaultDisplayName(undefined)).toBe("Member");
    expect([...defaultDisplayName({ name: "x".repeat(200) })]).toHaveLength(80);
  });
  it("maps roles and validates input", () => {
    expect(memberRoleForMembership("owner")).toBe("owner");
    expect(memberRoleForMembership("member")).toBe("adult");
    expect(normalizeDisplayName("  Nana   B ")).toBe("Nana B");
    expect(normalizeDisplayName("   ")).toBeNull();
    expect(normalizeDisplayName("x".repeat(81))).toBeNull();
    expect(normalizeContact(" Helper@Example.COM ")).toBe("helper@example.com");
    expect(normalizeContact("nope")).toBeNull();
  });
  it("round-trips contact ciphertext bound to tenant and subject", () => {
    const env = { NEO_MASTER_KEY: Buffer.alloc(32, 7).toString("base64") } as NodeJS.ProcessEnv;
    const ct = encryptContact("t1", "m1", "A@B.test", env);
    expect(ct).not.toContain("b.test");
    expect(decryptContact("t1", "m1", ct, env)).toBe("a@b.test");
    expect(() => decryptContact("t1", "m2", ct, env)).toThrow();
    expect(() => decryptContact("t2", "m1", ct, env)).toThrow();
    expect(() => encryptContact("t1", "m1", "x", env)).toThrow();
    expect(() => encryptContact("t1", "m1", "a@b.test", { NODE_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(/NEO_MASTER_KEY/);
  });
});

describe("migration 0017 backfill", () => {
  let client: PGlite;
  let tenantA: string;
  let tenantB: string;
  let ownerA: string;
  let kidA: string;
  let ownerB: string;
  let deviceA: string;
  let ackedAlert: string;
  let openAlert: string;

  beforeAll(async () => {
    // Journal truncated before 0017, seed pre-v2 rows, then apply the full folder.
    const old = mkdtempSync(join(tmpdir(), "neo-mig-"));
    cpSync(migrationsFolder, old, { recursive: true });
    const journalPath = join(old, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: Array<{ tag: string }> };
    journal.entries = journal.entries.filter((e) => e.tag !== "0017_v2_members");
    writeFileSync(journalPath, JSON.stringify(journal));

    client = new PGlite();
    await migrate(drizzle({ client, schema }), { migrationsFolder: old });

    const q = async (text: string, params: unknown[] = []) => (await client.query<{ id: string }>(text, params)).rows;
    const [uA] = await q(`insert into users (id, name, email) values (gen_random_uuid()::text, 'Pat', 'pat@x.test') returning id`);
    const [uK] = await q(`insert into users (id, name, email) values (gen_random_uuid()::text, null, 'kid.name@x.test') returning id`);
    const [uB] = await q(`insert into users (id, name, email) values (gen_random_uuid()::text, 'Bea', 'bea@x.test') returning id`);
    ownerA = uA!.id; kidA = uK!.id; ownerB = uB!.id;
    [{ id: tenantA }] = (await q(`insert into tenants (name, kind) values ('A', 'household') returning id`)) as [{ id: string }];
    [{ id: tenantB }] = (await q(`insert into tenants (name, kind) values ('B', 'household') returning id`)) as [{ id: string }];
    await q(`insert into memberships (tenant_id, user_id, role) values ($1,$2,'owner'),($1,$3,'member'),($4,$5,'owner')`, [tenantA, ownerA, kidA, tenantB, ownerB]);
    [{ id: deviceA }] = (await q(
      `insert into devices (tenant_id, user_id, kind, platform, name, client_version, enrollment) values ($1,$2,'desktop_agent','linux','Laptop','1.0.0','self') returning id`,
      [tenantA, kidA],
    )) as [{ id: string }];
    await q(`insert into device_enrollment_codes (tenant_id, user_id, code_hash, expires_at) values ($1,$2,'h1', now() + interval '1 day')`, [tenantA, kidA]);
    [{ id: ackedAlert }] = (await q(
      `insert into alerts (tenant_id, subject_user_id, kind, severity, title, body, dedupe_key, acknowledged_at) values ($1,$2,'member_verdict','high','t','b','k1', now()) returning id`,
      [tenantA, kidA],
    )) as [{ id: string }];
    [{ id: openAlert }] = (await q(
      `insert into alerts (tenant_id, subject_user_id, kind, severity, title, body, dedupe_key) values ($1,$2,'member_verdict','high','t','b','k2') returning id`,
      [tenantA, kidA],
    )) as [{ id: string }];

    await migrate(drizzle({ client, schema }), { migrationsFolder });
  }, 60_000);
  afterAll(async () => {
    await client.close();
  });

  it("creates one member per membership with derived names and roles", async () => {
    const rows = (await client.query<{ tenant_id: string; user_id: string; display_name: string; role: string; mode: string }>(`select * from members`)).rows;
    expect(rows).toHaveLength(3);
    const by = (u: string) => rows.find((r) => r.user_id === u)!;
    expect(by(ownerA)).toMatchObject({ tenant_id: tenantA, display_name: "Pat", role: "owner", mode: "standard" });
    expect(by(kidA)).toMatchObject({ display_name: "kid.name", role: "adult", mode: "standard" });
    expect(by(ownerB)).toMatchObject({ tenant_id: tenantB, display_name: "Bea", role: "owner" });
  });

  it("backfills member_id on devices, codes and alerts, and alert status", async () => {
    const kid = (await client.query<{ id: string }>(`select id from members where user_id = $1`, [kidA])).rows[0]!.id;
    expect((await client.query<{ member_id: string }>(`select member_id from devices where id = $1`, [deviceA])).rows[0]!.member_id).toBe(kid);
    expect((await client.query<{ member_id: string }>(`select member_id from device_enrollment_codes`)).rows[0]!.member_id).toBe(kid);
    const al = (await client.query<{ id: string; status: string; member_id: string }>(`select id, status, member_id from alerts`)).rows;
    expect(al.find((a) => a.id === ackedAlert)).toMatchObject({ status: "acknowledged", member_id: kid });
    expect(al.find((a) => a.id === openAlert)).toMatchObject({ status: "open", member_id: kid });
  });

  it("accepts the new alert kinds and rejects unknown ones", async () => {
    const ins = (kind: string) =>
      client.query(`insert into alerts (tenant_id, kind, severity, title, body, dedupe_key) values ($1,$2,'low','t','b',$3)`, [tenantA, kind, `d-${kind}`]);
    for (const k of ["install_during_session", "payment_under_pressure", "protection_disabled"]) await ins(k);
    await expect(ins("nonsense")).rejects.toThrow();
  });
});

describe("members API", () => {
  let t: TestDb;
  let tenant: string;
  let other: string;
  let owner: string;
  let nana: string;

  beforeAll(async () => {
    t = await createTestDb();
    await becomeAppUser(t.client);
    owner = await createUser(t.db, "Pat");
    nana = await createUser(t.db, "Nana");
    const ownerB = await createUser(t.db, "Bea");
    ({ tenantId: tenant } = await createTenantForUser(t.db, { userId: owner, name: "Pat's" }));
    ({ tenantId: other } = await createTenantForUser(t.db, { userId: ownerB, name: "Bea's" }));
  });
  afterAll(async () => {
    await t.close();
  });

  it("creates the owner's member with the household and isolates tenants", async () => {
    const list = await listMembers(tenantScoped(t.db, tenant));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ userId: owner, displayName: "Pat", role: "owner", mode: "standard", hasContact: false, helperMemberIds: [] });
    expect(await listMembers(tenantScoped(t.db, other))).toHaveLength(1);
    // Another tenant's handle cannot read or touch this member.
    expect(await getMember(tenantScoped(t.db, other), list[0]!.id)).toBeUndefined();
    expect(await updateMember(tenantScoped(t.db, other), list[0]!.id, { displayName: "X" })).toBeUndefined();
    expect(await t.db.select().from(members)).toHaveLength(0); // RLS: no tenant context, no rows
  });

  it("adds a member on invite accept, sets member_id on codes, and removes it on leave", async () => {
    const inv = await createHouseholdInvite(t.db, { tenantId: tenant, invitedBy: owner, kind: "link" });
    if ("error" in inv) throw new Error(inv.error);
    const r = await acceptHouseholdInvite(t.db, { secret: inv.secret, userId: nana, confirmLeave: true });
    expect(r.status).toBe("accepted");
    const tdb = tenantScoped(t.db, tenant);
    const m = await getMemberByUserId(tdb, nana);
    expect(m).toMatchObject({ displayName: "Nana", role: "adult", mode: "standard" });

    const code = await createEnrollmentCode(t.db, { tenantId: tenant, userId: nana, createdBy: owner });
    if ("error" in code) throw new Error(code.error);
    const [row] = await tdb.select(deviceEnrollmentCodes);
    expect(row!.memberId).toBe(m!.id);

    const helper = (await getMemberByUserId(tdb, owner))!;
    const updated = await updateMember(tdb, m!.id, {
      displayName: "Grandma",
      mode: "elder",
      role: "elder",
      birthYear: 1948,
      helperMemberIds: [helper.id],
      contact: "Helper@Example.com",
    });
    expect(updated).toMatchObject({ displayName: "Grandma", mode: "elder", role: "elder", birthYear: 1948, helperMemberIds: [helper.id], hasContact: true });
    expect(updated).not.toHaveProperty("contactCiphertext");
    expect(await getMemberContact(tdb, m!.id)).toBe("helper@example.com");
    const [raw] = await tdb.select(members, undefined, { limit: 5 });
    expect(JSON.stringify(raw)).not.toContain("helper@example.com");

    await expect(updateMember(tdb, m!.id, { role: "owner" })).rejects.toThrow();
    await expect(updateMember(tdb, helper.id, { role: "adult" })).rejects.toThrow();
    await expect(updateMember(tdb, m!.id, { helperMemberIds: [m!.id] })).rejects.toThrow();
    await expect(updateMember(tdb, m!.id, { helperMemberIds: [crypto.randomUUID()] })).rejects.toThrow();
    await expect(updateMember(tdb, m!.id, { displayName: " " })).rejects.toThrow();
    await expect(updateMember(tdb, m!.id, { mode: "bogus" as never })).rejects.toThrow();
    expect((await updateMember(tdb, m!.id, { contact: null }))?.hasContact).toBe(false);

    // Alerts and devices pick up the member.
    const alert = await createAlert(t.db, { tenantId: tenant, subjectUserId: nana, kind: "member_verdict", severity: "high", title: "t", body: "b", dedupeKey: "a1" });
    expect(alert).toMatchObject({ memberId: m!.id, status: "open", signalIds: [] });
    const acked = await acknowledgeAlert(t.db, tenant, alert!.id, owner);
    expect(acked).toMatchObject({ status: "acknowledged" });
    const explicit = await createAlert(t.db, { tenantId: tenant, subjectUserId: null, memberId: helper.id, signalIds: [crypto.randomUUID()], kind: "protection_disabled", severity: "high", title: "t", body: "b", dedupeKey: "a2" });
    expect(explicit?.memberId).toBe(helper.id);
    expect(explicit?.signalIds).toHaveLength(1);

    expect(await leaveHousehold(t.db, { tenantId: tenant, userId: nana })).toMatchObject({ status: "left" });
    expect(await getMemberByUserId(tdb, nana)).toBeUndefined();
    // Helper lists no longer reference a deleted member (the leaver was not a helper here).
    expect(await deleteMemberForUser(tdb, nana)).toBe(false);
  });

  it("createMemberForUser is idempotent and deleteMemberForUser scrubs helper lists", async () => {
    const tdb = tenantScoped(t.db, tenant);
    const kid = await createUser(t.db, "Kid");
    const a = await createMemberForUser(tdb, { userId: kid, role: "child" });
    const b = await createMemberForUser(tdb, { userId: kid, role: "child" });
    expect(b.id).toBe(a.id);
    expect(a.displayName).toBe("Kid");
    const ownerMember = (await getMemberByUserId(tdb, owner))!;
    await updateMember(tdb, ownerMember.id, { helperMemberIds: [a.id] });
    expect(await deleteMemberForUser(tdb, kid)).toBe(true);
    expect((await getMember(tdb, ownerMember.id))?.helperMemberIds).toEqual([]);
    expect(await getMember(tdb, "not-a-uuid")).toBeUndefined();
  });

  it("appends policy versions per scope and reads the latest layers", async () => {
    const tdb = tenantScoped(t.db, tenant);
    const me = (await getMemberByUserId(tdb, owner))!;
    expect(await getProtectionLayers(tdb, { userId: "nobody" })).toEqual({ memberId: null, mode: "standard" });
    expect(await getProtectionLayers(tdb, { userId: owner })).toEqual({ memberId: me.id, mode: "standard" });

    expect(await insertPolicyVersion(tdb, { scope: "household", scopeId: null, rules: { v: 1 }, createdBy: owner })).toMatchObject({ version: 1 });
    expect(await insertPolicyVersion(tdb, { scope: "household", scopeId: null, rules: { v: 2 } })).toMatchObject({ version: 2 });
    expect(await insertPolicyVersion(tdb, { scope: "member", scopeId: me.id, rules: { m: 1 } })).toMatchObject({ version: 1 });
    await updateMember(tdb, me.id, { mode: "standard" });
    const layers = await getProtectionLayers(tdb, { userId: owner });
    expect(layers).toEqual({ memberId: me.id, mode: "standard", household: { v: 2 }, member: { m: 1 } });

    // Device layer only for a device in this household.
    const [dev] = await tdb.insert(devices, { userId: owner, memberId: me.id, kind: "desktop_agent", platform: "linux", name: "L", clientVersion: "1", enrollment: "self" });
    await insertPolicyVersion(tdb, { scope: "device", scopeId: dev!.id, rules: { d: 1 } });
    expect((await getProtectionLayers(tdb, { userId: owner, deviceId: dev!.id })).device).toEqual({ d: 1 });
    expect((await getProtectionLayers(tdb, { userId: owner, deviceId: crypto.randomUUID() })).device).toBeUndefined();
    // Other tenant sees none of it.
    expect((await getProtectionLayers(tenantScoped(t.db, other), { userId: owner })).household).toBeUndefined();

    await expect(insertPolicyVersion(tdb, { scope: "household", scopeId: me.id, rules: {} })).rejects.toThrow();
    await expect(insertPolicyVersion(tdb, { scope: "member", scopeId: null, rules: {} })).rejects.toThrow();
  });
});
