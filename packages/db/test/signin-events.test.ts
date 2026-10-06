import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { leaveHousehold } from "../src/household.js";
import { knownSigninDevices, memberships, signinEvents, users, verdicts } from "../src/schema/index.js";
import { tenantScoped, tenantTables } from "../src/tenant.js";
import { createTenantForUser } from "../src/tenants.js";
import { becomeAppUser, createTestDb, createUser, type TestDb } from "./helpers.js";

let t: TestDb;
let ownerA: string;
let tenantA: string;
let memberA: string;
let ownerB: string;
let tenantB: string;
let seq = 0;

async function addMember(tenantId: string): Promise<string> {
  seq += 1;
  const [row] = await t.db.insert(users).values({ name: "M", email: `se${seq}-${Date.now()}@example.test` }).returning({ id: users.id });
  await tenantScoped(t.db, tenantId).insert(memberships, { userId: row!.id, role: "member" });
  return row!.id;
}

beforeAll(async () => {
  t = await createTestDb({ createAppUserBeforeMigrations: true });
  const grants = await t.client.query<{ ok: boolean }>(
    `SELECT bool_and(has_table_privilege('app_user', 'public.' || tbl, p)) AS ok FROM unnest(ARRAY['signin_events','known_signin_devices']) tbl, unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p`,
  );
  expect(grants.rows[0]?.ok).toBe(true);
  ownerA = await createUser(t.db);
  tenantA = (await createTenantForUser(t.db, { userId: ownerA, name: "A" })).tenantId;
  memberA = await addMember(tenantA);
  ownerB = await createUser(t.db);
  tenantB = (await createTenantForUser(t.db, { userId: ownerB, name: "B" })).tenantId;
  await becomeAppUser(t.client);
}, 60_000);
afterAll(async () => { await t?.close(); });

const event = (userId: string, extra: Record<string, unknown> = {}) => ({
  userId, provider: "google", event: "new_signin", deviceLabel: "Windows", coarseLocation: "Seattle, WA", source: "forwarded" as const, authenticated: true, ...extra,
});

describe("sign-in events and known devices (PGlite as app_user)", () => {
  it("registers both tables as tenant tables with RLS enabled", async () => {
    expect(tenantTables.signinEvents).toBe(signinEvents);
    expect(tenantTables.knownSigninDevices).toBe(knownSigninDevices);
    for (const table of ["signin_events", "known_signin_devices"]) {
      const r = await t.client.query<{ relrowsecurity: boolean }>(`select relrowsecurity from pg_class where relname = '${table}'`);
      expect(r.rows[0]?.relrowsecurity, table).toBe(true);
    }
  });

  it("records events, reports known-device status, and remembers/forgets a device idempotently", async () => {
    const db = tenantScoped(t.db, tenantA).signinEvents;
    const first = await db.record(event(memberA, { eventTime: new Date("2026-01-15T12:00:00Z") }));
    expect(first).toMatchObject({ provider: "google", deviceLabel: "Windows", deviceKnown: false, source: "forwarded", authenticated: true });
    expect(await db.isKnownDevice(memberA, "google", "Windows")).toBe(false);
    await db.rememberDevice(memberA, "google", "Windows");
    await db.rememberDevice(memberA, "google", "Windows");
    expect(await tenantScoped(t.db, tenantA).count(knownSigninDevices)).toBe(1);
    expect(await db.isKnownDevice(memberA, "google", "Windows")).toBe(true);
    expect(await db.isKnownDevice(memberA, "microsoft", "Windows")).toBe(false);
    const second = await db.record(event(memberA, { source: "outlook", authenticated: false }));
    expect(second.deviceKnown).toBe(true);
    const listed = await db.list(memberA);
    expect(listed).toHaveLength(2);
    expect(listed.every((e) => e.deviceKnown)).toBe(true);
    await db.forgetDevice(memberA, "google", "Windows");
    await db.forgetDevice(memberA, "google", "Windows");
    expect((await db.list(memberA)).every((e) => !e.deviceKnown)).toBe(true);
  });

  it("lists only the requested member's events and records events without a device", async () => {
    const db = tenantScoped(t.db, tenantA).signinEvents;
    await db.record(event(ownerA, { deviceLabel: null, event: "password_changed" }));
    expect((await db.list(ownerA)).map((e) => e.event)).toEqual(["password_changed"]);
    expect((await db.list(memberA)).every((e) => e.userId === memberA)).toBe(true);
  });

  it("rejects values outside the provider/event/source enums", async () => {
    const db = tenantScoped(t.db, tenantA).signinEvents;
    await expect(db.record(event(memberA, { provider: "yahoo" }))).rejects.toThrow();
    await expect(db.record(event(memberA, { event: "security_change" }))).rejects.toThrow();
    await expect(db.record(event(memberA, { source: "imap" }))).rejects.toThrow();
  });

  it("isolates tenants: no cross-tenant reads, and RLS hides rows without a tenant context", async () => {
    const b = tenantScoped(t.db, tenantB).signinEvents;
    expect(await b.list(memberA)).toEqual([]);
    expect(await b.isKnownDevice(memberA, "google", "Windows")).toBe(false);
    // The membership FK needs the user to belong to the tenant.
    await expect(b.record(event(memberA))).rejects.toThrow();
    await b.record(event(ownerB));
    await t.client.exec(`select set_config('app.tenant_id', '${tenantB}', false)`);
    const seen = await t.client.query<{ user_id: string }>(`select user_id from signin_events`);
    expect(seen.rows.map((r) => r.user_id)).toEqual([ownerB]);
    await t.client.exec(`select set_config('app.tenant_id', '', false)`);
    expect((await t.client.query(`select 1 from signin_events`)).rows).toEqual([]);
    expect((await t.client.query(`select 1 from known_signin_devices`)).rows).toEqual([]);
  });

  it("deleteForUser removes only that member's events and devices", async () => {
    const db = tenantScoped(t.db, tenantA).signinEvents;
    await db.rememberDevice(ownerA, "apple", "iPhone");
    expect(await db.deleteForUser(ownerA)).toBeGreaterThan(0);
    expect(await db.list(ownerA)).toEqual([]);
    expect(await db.isKnownDevice(ownerA, "apple", "iPhone")).toBe(false);
    expect((await db.list(memberA)).length).toBeGreaterThan(0);
  });

  it("deletes a member's events and devices when they leave, and with the verdict they came from", async () => {
    const leaver = await addMember(tenantA);
    const db = tenantScoped(t.db, tenantA).signinEvents;
    await db.record(event(leaver));
    await db.rememberDevice(leaver, "google", "Windows");
    expect(await db.list(leaver)).toHaveLength(1);
    expect((await leaveHousehold(t.db, { tenantId: tenantA, userId: leaver })).status).toBe("left");
    expect(await tenantScoped(t.db, tenantA).select(signinEvents, eq(signinEvents.userId, leaver))).toEqual([]);
    expect(await tenantScoped(t.db, tenantA).select(knownSigninDevices, eq(knownSigninDevices.userId, leaver))).toEqual([]);

    const [v] = await tenantScoped(t.db, tenantA).insert(verdicts, { userId: memberA, source: "chat", subjectType: "signin_alert", verdict: "suspicious", confidence: 0.5, headline: "h", body: {} });
    await db.record(event(memberA, { verdictId: v!.id }));
    await tenantScoped(t.db, tenantA).delete(verdicts, eq(verdicts.id, v!.id));
    expect((await db.list(memberA)).some((e) => e.verdictId === v!.id)).toBe(false);

    // Direct membership removal cascades too.
    await tenantScoped(t.db, tenantB).signinEvents.rememberDevice(ownerB, "google", "Windows");
    await tenantScoped(t.db, tenantB).delete(memberships, and(eq(memberships.userId, ownerB)));
    expect(await tenantScoped(t.db, tenantB).count(knownSigninDevices)).toBe(0);
    expect(await tenantScoped(t.db, tenantB).count(signinEvents)).toBe(0);
  });
});
