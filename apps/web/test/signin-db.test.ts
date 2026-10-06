// @vitest-environment node
/**
 * The sign-in alert database path on PGlite as the non-owner `app_user` role (RLS applies, unlike
 * db-integration.test.ts): known-device flow, event isolation per tenant and per member, the tool's
 * reads, and cascade on membership removal.
 */
import { PGlite } from "@electric-sql/pglite";
import { createTenantForUser, leaveHousehold, memberships, saveVerdict, schema, tenantScoped, users, type Db } from "@neo/db";
import { migrationsFolder } from "@neo/db/migrate";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createReviewMySigninsTool } from "@/lib/server/tools/review-my-signins";
import { answerSigninCheck, finalizeSigninVerdict, persistSigninEvent } from "@/lib/server/signin/service";
import { getSigninStore } from "@/lib/server/signin/store";
import type { NeoSession } from "@/lib/session";
import { analyzeRaw, googleAlertRaw, triaged } from "./signin-fixtures";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/server/db", () => ({ getDb: () => holder.db }));

let client: PGlite;
let db: Db;
let tenantA: string;
let tenantB: string;
let ownerA: string;
let memberA: string;
let ownerB: string;

const sessionOf = (tenantId: string, userId: string, role: "owner" | "member"): NeoSession => ({ tenantId, userId, role, email: `${userId}@example.test`, name: userId, scopes: ["full"] });

async function user(name: string): Promise<string> {
  const [row] = await db.insert(schema.users).values({ name, email: `${name}-${Date.now()}@example.test` }).returning({ id: users.id });
  return row!.id;
}

beforeAll(async () => {
  client = new PGlite();
  const d = drizzle({ client, schema });
  await client.exec(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN CREATE ROLE app_user NOLOGIN NOBYPASSRLS; END IF; END $$;`);
  await migrate(d, { migrationsFolder });
  db = d as unknown as Db;
  holder.db = db;
  ownerA = await user("ownerA");
  tenantA = (await createTenantForUser(db, { userId: ownerA, name: "A" })).tenantId;
  memberA = await user("memberA");
  await tenantScoped(db, tenantA).insert(memberships, { userId: memberA, role: "member" });
  ownerB = await user("ownerB");
  tenantB = (await createTenantForUser(db, { userId: ownerB, name: "B" })).tenantId;
  await client.exec(`
    grant usage on schema public to app_user;
    grant select, insert, update, delete on all tables in schema public to app_user;
    set role app_user;
  `);
}, 60_000);
afterAll(async () => {
  await client?.close();
});

describe("sign-in alerts on the database path (PGlite as app_user)", () => {
  it("first-seen flow: finalize -> save verdict -> persist event -> yes remembers -> next alert is known", async () => {
    const analysis = await analyzeRaw(googleAlertRaw());
    const fin = await finalizeSigninVerdict({ tenantId: tenantA, userId: memberA, analysis, verdict: triaged("suspicious"), source: "forwarded" });
    expect(fin.verdict.signin_check?.first_seen).toBe(true);
    const { id } = await saveVerdict(db, { tenantId: tenantA, userId: memberA, source: "inbound", verdict: fin.verdict });
    await persistSigninEvent({ tenantId: tenantA, userId: memberA, verdictId: id, event: fin.event });
    expect(await getSigninStore().list(tenantA, memberA)).toEqual([expect.objectContaining({ verdictId: id, provider: "google", deviceKnown: false })]);

    // Only the member answers: the owner gets "not found", and nothing is remembered.
    expect(await answerSigninCheck(sessionOf(tenantA, ownerA, "owner"), id, "yes")).toEqual({ status: "not_found" });
    expect(await getSigninStore().isKnownDevice(tenantA, memberA, "google", "Windows")).toBe(false);
    expect(await answerSigninCheck(sessionOf(tenantA, memberA, "member"), id, "yes")).toEqual({ status: "ok" });
    expect(await getSigninStore().isKnownDevice(tenantA, memberA, "google", "Windows")).toBe(true);

    const again = await finalizeSigninVerdict({ tenantId: tenantA, userId: memberA, analysis, verdict: triaged("suspicious"), source: "forwarded" });
    expect(again.verdict.signin_check?.first_seen).toBe(false);

    expect(await answerSigninCheck(sessionOf(tenantA, memberA, "member"), id, "no")).toEqual({ status: "ok", playbook: "account_takeover" });
    expect(await getSigninStore().isKnownDevice(tenantA, memberA, "google", "Windows")).toBe(false);
  });

  it("409-equivalent for a verdict without a check; other tenants see nothing", async () => {
    const { id } = await saveVerdict(db, { tenantId: tenantA, userId: memberA, source: "chat", verdict: triaged("suspicious") });
    expect(await answerSigninCheck(sessionOf(tenantA, memberA, "member"), id, "yes")).toEqual({ status: "no_check" });
    expect(await answerSigninCheck(sessionOf(tenantB, ownerB, "owner"), id, "yes")).toEqual({ status: "not_found" });
    expect(await getSigninStore().list(tenantB, memberA)).toEqual([]);
  });

  it("the chat tool reads only the session member's stored events from the database", async () => {
    await getSigninStore().record(tenantA, { userId: ownerA, provider: "paypal", event: "password_changed", source: "forwarded", authenticated: true });
    const tool = createReviewMySigninsTool();
    const mine = (await tool.execute({}, { tenantId: tenantA, userId: memberA, conversationId: "c" })) as { events: { provider: string }[] };
    expect(mine.events.length).toBeGreaterThan(0);
    expect(mine.events.every((e) => e.provider === "google")).toBe(true);
    const owners = (await tool.execute({}, { tenantId: tenantA, userId: ownerA, conversationId: "c" })) as { events: { provider: string }[] };
    expect(owners.events.map((e) => e.provider)).toEqual(["paypal"]);
  });

  it("RLS: without the tenant context nothing is readable, and removal deletes the member's events and devices", async () => {
    expect((await client.query(`select 1 from signin_events`)).rows).toEqual([]);
    expect((await client.query(`select 1 from known_signin_devices`)).rows).toEqual([]);
    await getSigninStore().rememberDevice(tenantA, memberA, "google", "Windows");
    expect(await tenantScoped(db, tenantA).signinEvents.list(memberA)).not.toEqual([]);
    expect((await leaveHousehold(db, { tenantId: tenantA, userId: memberA })).status).toBe("left");
    expect(await tenantScoped(db, tenantA).signinEvents.list(memberA)).toEqual([]);
    expect(await getSigninStore().isKnownDevice(tenantA, memberA, "google", "Windows")).toBe(false);
    expect(await tenantScoped(db, tenantA).signinEvents.list(ownerA)).toHaveLength(1); // the owner's own row is untouched
  });
});
