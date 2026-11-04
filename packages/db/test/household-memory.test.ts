/**
 * Household memory (_specs/v2-m3-cutover.md section 3; migration 0028_household_memory) on PGlite as the
 * non-owner app role: RLS, the cap, scoping of lists, hard delete and the cross-household purge.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HOUSEHOLD_MEMORY_MAX,
  HOUSEHOLD_MEMORY_RETENTION_DAYS,
  addHouseholdMemory,
  forgetHouseholdMemory,
  listHouseholdMemory,
  purgeExpiredHouseholdMemory,
} from "../src/household-memory.js";
import { createMemberWithoutAccount } from "../src/members.js";
import { householdMemory } from "../src/schema/index.js";
import { tenantScoped } from "../src/tenant.js";
import { createTenantForUser } from "../src/tenants.js";
import { becomeAppUser, createTestDb, createUser, type TestDb } from "./helpers.js";

let t: TestDb;
let ownerId: string;
let otherOwnerId: string;
let tenantId: string;
let otherTenantId: string;
let gran: string;
let sam: string;
const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  t = await createTestDb({ createAppUserBeforeMigrations: true });
  ownerId = await createUser(t.db, "Pat");
  otherOwnerId = await createUser(t.db, "Other");
  tenantId = (await createTenantForUser(t.db, { userId: ownerId, name: "Pat's household" })).tenantId;
  otherTenantId = (await createTenantForUser(t.db, { userId: otherOwnerId, name: "Other household" })).tenantId;
  gran = (await createMemberWithoutAccount(tenantScoped(t.db, tenantId), { displayName: "Gran", role: "elder" })).id;
  sam = (await createMemberWithoutAccount(tenantScoped(t.db, tenantId), { displayName: "Sam", role: "child", birthYear: 2015 })).id;
  await becomeAppUser(t.client);
});
afterAll(async () => {
  await t.client.exec("reset role");
  await t.close();
});

const tdb = () => tenantScoped(t.db, tenantId);
const add = (text: string, subjectMemberId: string | null = null, over: { now?: Date; tid?: string } = {}) =>
  addHouseholdMemory(tenantScoped(t.db, over.tid ?? tenantId), { text, subjectMemberId, createdBy: over.tid ? otherOwnerId : ownerId, source: "console", ...(over.now ? { now: over.now } : {}) });

describe("migration 0028_household_memory", () => {
  it("has tenant RLS and the table is a tenant table", async () => {
    const rls = await t.client.query<{ relrowsecurity: boolean }>("select relrowsecurity from pg_class where relname = 'household_memory'");
    expect(rls.rows[0]?.relrowsecurity).toBe(true);
    const pol = await t.client.query<{ policyname: string }>("select policyname from pg_policies where tablename = 'household_memory'");
    expect(pol.rows.map((p) => p.policyname)).toEqual(["tenant_isolation"]);
  });

  it("stores a memory with a 365-day expiry and the checks hold", async () => {
    const now = new Date("2026-11-03T10:00:00Z");
    const r = await add("Gran's helper is Patrick.", gran, { now });
    expect(r.outcome).toBe("created");
    if (r.outcome !== "created") return;
    expect(r.row.expiresAt.getTime() - now.getTime()).toBe(HOUSEHOLD_MEMORY_RETENTION_DAYS * DAY);
    expect(r.row).toMatchObject({ source: "console", subjectMemberId: gran, createdBy: ownerId });
    await expect(tdb().insert(householdMemory, { text: "x".repeat(281), source: "console", expiresAt: new Date() })).rejects.toThrow();
    await expect(tdb().insert(householdMemory, { text: "", source: "console", expiresAt: new Date() })).rejects.toThrow();
    await expect(tdb().insert(householdMemory, { text: "ok", source: "email" as never, expiresAt: new Date() })).rejects.toThrow();
  });

  it("returns an identical live entry instead of adding it twice", async () => {
    const a = await add("Gran likes calls on Sundays.");
    const b = await add("  gran likes calls on sundays.  ");
    expect(a.outcome).toBe("created");
    expect(b.outcome).toBe("duplicate");
    // The same words about someone else are a different memory.
    expect((await add("Gran likes calls on Sundays.", gran)).outcome).toBe("created");
  });

  it("refuses a subject outside the household", async () => {
    const foreign = (await createMemberWithoutAccount(tenantScoped(t.db, otherTenantId), { displayName: "Stranger", role: "adult" })).id;
    expect((await add("About a stranger.", foreign)).outcome).toBe("bad_subject");
    expect((await add("About nobody.", "not-a-uuid")).outcome).toBe("bad_subject");
    expect((await add("About a missing member.", crypto.randomUUID())).outcome).toBe("bad_subject");
  });
});

describe("scoping and isolation", () => {
  it("lists everything for the owner view and only household-wide plus own for a member", async () => {
    await add("Household rule: ask before installing anything.");
    await add("Sam may use the family PC until 8pm.", sam);
    const all = (await listHouseholdMemory(tdb())).map((r) => r.text);
    expect(all).toEqual(expect.arrayContaining(["Gran's helper is Patrick.", "Household rule: ask before installing anything.", "Sam may use the family PC until 8pm."]));
    const forSam = (await listHouseholdMemory(tdb(), { forMemberId: sam })).map((r) => r.text);
    expect(forSam).toContain("Sam may use the family PC until 8pm.");
    expect(forSam).toContain("Household rule: ask before installing anything.");
    expect(forSam).not.toContain("Gran's helper is Patrick.");
    const noMember = (await listHouseholdMemory(tdb(), { forMemberId: null })).map((r) => r.text);
    expect(noMember).toContain("Household rule: ask before installing anything.");
    expect(noMember).not.toContain("Sam may use the family PC until 8pm.");
  });

  it("never shows another household's entries, and RLS hides them even from a raw query", async () => {
    await add("Other household secret fact.", null, { tid: otherTenantId });
    expect((await listHouseholdMemory(tdb())).some((r) => r.text.startsWith("Other household"))).toBe(false);
    expect((await listHouseholdMemory(tenantScoped(t.db, otherTenantId))).map((r) => r.text)).toEqual(["Other household secret fact."]);
    // Without a tenant context the app role sees nothing.
    const raw = await t.client.query("select id from household_memory");
    expect(raw.rows).toHaveLength(0);
  });

  it("does not list expired entries", async () => {
    const past = new Date(Date.now() - 400 * DAY);
    await add("An old fact.", null, { now: past });
    expect((await listHouseholdMemory(tdb())).some((r) => r.text === "An old fact.")).toBe(false);
  });
});

describe("forget and purge", () => {
  it("forgets at once (hard delete) and only inside the household", async () => {
    const created = await add("Forget me.");
    if (created.outcome !== "created") throw new Error("expected created");
    expect(await forgetHouseholdMemory(tenantScoped(t.db, otherTenantId), created.row.id)).toBe(false);
    expect(await forgetHouseholdMemory(tdb(), "nope")).toBe(false);
    expect(await forgetHouseholdMemory(tdb(), created.row.id)).toBe(true);
    expect(await forgetHouseholdMemory(tdb(), created.row.id)).toBe(false);
    expect((await listHouseholdMemory(tdb())).some((r) => r.id === created.row.id)).toBe(false);
  });

  it("purges expired entries across households, leaving live ones", async () => {
    const live = (await listHouseholdMemory(tdb())).length;
    const now = new Date();
    const gone = await purgeExpiredHouseholdMemory(t.db, new Date(now.getTime() + 1000));
    expect(gone).toBe(1); // the 400-day-old one; the other household's is live
    expect((await listHouseholdMemory(tdb())).length).toBe(live);
    expect(await purgeExpiredHouseholdMemory(t.db, new Date(now.getTime() + 2 * 366 * DAY))).toBeGreaterThanOrEqual(live);
    expect(await listHouseholdMemory(tdb(), { now: new Date(now.getTime() + 3 * 366 * DAY) })).toHaveLength(0);
  });
});

describe("the cap", () => {
  it("allows 100 live entries per household and refuses the 101st; another household is unaffected", async () => {
    const tid = (await createTenantForUser(t.db, { userId: await createUser(t.db, "Capper"), name: "Cap" })).tenantId;
    for (let i = 0; i < HOUSEHOLD_MEMORY_MAX; i += 1) {
      expect((await add(`Fact number ${i}.`, null, { tid })).outcome).toBe("created");
    }
    expect((await add("One too many.", null, { tid })).outcome).toBe("limit");
    // Forgetting one frees a slot.
    const [first] = await listHouseholdMemory(tenantScoped(t.db, tid));
    await forgetHouseholdMemory(tenantScoped(t.db, tid), first!.id);
    expect((await add("One more.", null, { tid })).outcome).toBe("created");
    expect((await add("Fits elsewhere.")).outcome).toBe("created");
  }, 60_000);
});
