// @vitest-environment node
/** The Outlook connector tables on PGlite as the non-owner `app_user` (RLS applies). */
import { PGlite } from "@electric-sql/pglite";
import { createTenantForUser, leaveHousehold, memberships, outlookScheduler, schema, tenantScoped, users, type Db } from "@neo/db";
import { migrationsFolder } from "@neo/db/migrate";
import { sql } from "drizzle-orm";
import { encryptTokens } from "@/lib/server/outlook/crypto";
import type { OutlookDeps } from "@/lib/server/outlook/deps";
import { createDbOutlookStore } from "@/lib/server/outlook/store";
import { getAccessToken } from "@/lib/server/outlook/token";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let client: PGlite;
let db: Db;
let tenantA: string;
let tenantB: string;
let memberA: string;
let ownerB: string;
const bytes = (s: string) => new TextEncoder().encode(s);

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
  const ownerA = await user("ownerA");
  tenantA = (await createTenantForUser(db, { userId: ownerA, name: "A" })).tenantId;
  memberA = await user("memberA");
  await tenantScoped(db, tenantA).insert(memberships, { userId: memberA, role: "member" });
  ownerB = await user("ownerB");
  tenantB = (await createTenantForUser(db, { userId: ownerB, name: "B" })).tenantId;
  // Every other table gets the blanket grant from packages/db/sql/create-app-user.sql; the outlook_* tables and
  // list_outlook_connectors get none here, so what app_user can do with them is exactly what migration 0016 grants.
  await client.exec(`grant usage on schema public to app_user;
    DO $$ DECLARE t text; BEGIN
      FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE 'outlook\\_%' LOOP
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO app_user', t);
      END LOOP;
    END $$;
    set role app_user;`);
}, 60_000);
afterAll(async () => { await client?.close(); });

describe("outlook tables as app_user", () => {
  it("state: single use, expiry, bound to the user, cascade-able", async () => {
    const q = tenantScoped(db, tenantA).outlookOAuthStates;
    const now = new Date();
    await q.create({ id: crypto.randomUUID(), userId: memberA, stateHash: bytes("h1"), encryptedPkceVerifier: bytes("v"), expiresAt: new Date(now.getTime() + 600_000) });
    expect(await q.consume(bytes("h1"), "someone-else", now)).toBeUndefined();
    expect(await q.consume(bytes("h1"), memberA, new Date(now.getTime() + 601_000))).toBeUndefined();
    expect(await q.consume(bytes("h1"), memberA, now)).toMatchObject({ userId: memberA });
    expect(await q.consume(bytes("h1"), memberA, now)).toBeUndefined();
    expect(await q.purge(now)).toBe(1);
  });
  it("connector: CAS by version, reauth drops tokens, findings upsert/resolve, other tenants see nothing", async () => {
    const q = tenantScoped(db, tenantA);
    const id = crypto.randomUUID();
    const c = await q.outlookConnectors.upsertConnected({ id, userId: memberA, microsoftUserId: "ms1", displayAddress: "a@outlook.com", encryptedTokens: bytes("t1") });
    expect(c).toMatchObject({ id, status: "connected", tokenVersion: 1 });
    expect(await q.outlookConnectors.compareAndSwapTokens(id, 1, bytes("t2"))).toBe(true);
    expect(await q.outlookConnectors.compareAndSwapTokens(id, 1, bytes("t3"))).toBe(false);
    expect(Buffer.from((await q.outlookConnectors.get(memberA))!.encryptedTokens!).toString()).toBe("t2");
    expect(await q.outlookConnectors.listSummaries()).toEqual([{ userId: memberA, status: "connected" }]);
    expect((await outlookScheduler.listConnected(db)).items).toEqual([{ tenantId: tenantA, userId: memberA, connectorId: id }]);

    const f = await q.outlookRuleFindings.upsert({ userId: memberA, connectorId: id, ruleKey: "k", action: "forward_to", destinationDomain: "x.example" });
    expect(f.created).toBe(true);
    expect((await q.outlookRuleFindings.upsert({ userId: memberA, connectorId: id, ruleKey: "k", action: "forward_to" })).created).toBe(false);
    expect(await q.outlookRuleFindings.resolveMissing(id, [], new Date())).toBe(1);
    expect((await q.outlookRuleFindings.upsert({ userId: memberA, connectorId: id, ruleKey: "k", action: "forward_to", now: new Date(Date.now() + 1000) })).created).toBe(true);

    const other = tenantScoped(db, tenantB);
    expect(await other.outlookConnectors.get(memberA)).toBeUndefined();
    expect(await other.outlookConnectors.getById(id)).toBeUndefined();
    expect(await other.outlookRuleFindings.list(memberA)).toEqual([]);
    expect(await other.outlookConnectors.compareAndSwapTokens(id, 2, bytes("evil"))).toBe(false);
    expect((await client.query(`select 1 from outlook_connectors`)).rows).toEqual([]); // no tenant context
    expect((await client.query(`select 1 from outlook_rule_findings`)).rows).toEqual([]);
    expect((await client.query(`select 1 from outlook_oauth_states`)).rows).toEqual([]);

    expect(await q.outlookConnectors.markReauthRequired(id, 2)).toBe(true);
    const re = (await q.outlookConnectors.get(memberA))!;
    expect(re.status).toBe("reauth_required");
    expect(re.encryptedTokens).toBeUndefined();
    expect((await outlookScheduler.listConnected(db)).items).toEqual([]);
    await q.outlookConnectors.upsertConnected({ id: crypto.randomUUID(), userId: memberA, microsoftUserId: "ms1", displayAddress: "a@outlook.com", encryptedTokens: bytes("t9") });
    expect(await q.outlookConnectors.disconnect(memberA)).toBe(true);
    const gone = (await q.outlookConnectors.get(memberA))!;
    expect(gone.status).toBe("disconnected");
    expect(gone.encryptedTokens).toBeUndefined();
    expect(gone.encryptedDeltaCursor).toBeUndefined();
    expect(await q.outlookRuleFindings.list(memberA)).toHaveLength(1); // findings outlive disconnect
  });
  it("a tenant cannot write a finding for another tenant's connector, and the mailbox_forwarding alert kind is allowed", async () => {
    const c = (await tenantScoped(db, tenantA).outlookConnectors.get(memberA))!;
    await expect(tenantScoped(db, tenantB).outlookRuleFindings.upsert({ userId: ownerB, connectorId: c.id, ruleKey: "z", action: "forward_to" })).rejects.toThrow();
    await tenantScoped(db, tenantA).transaction(({ tx }) => tx.execute(sql`INSERT INTO public.alerts (tenant_id, subject_user_id, kind, severity, title, body, dedupe_key) VALUES (${tenantA}::uuid, ${memberA}, 'mailbox_forwarding', 'high', 't', 'b', 'k1')`));
  });
  it("leaving the household deletes the connector and its findings", async () => {
    expect((await leaveHousehold(db, { tenantId: tenantA, userId: memberA })).status).toBe("left");
    const q = tenantScoped(db, tenantA);
    expect(await q.outlookConnectors.get(memberA)).toBeUndefined();
    expect(await q.outlookRuleFindings.list(memberA)).toEqual([]);
  });
});

describe("review fixes against the database", () => {
  let member: string;
  let id: string;
  beforeAll(async () => {
    member = await user("memberC");
    await tenantScoped(db, tenantA).insert(memberships, { userId: member, role: "member" });
    id = crypto.randomUUID();
    await tenantScoped(db, tenantA).outlookConnectors.upsertConnected({ id, userId: member, microsoftUserId: "ms-c", displayAddress: "c@outlook.com", encryptedTokens: bytes("t1") });
  });

  it("list_outlook_connectors: app_user (granted by the migration) gets identifiers only; EXECUTE is revoked from PUBLIC", async () => {
    const res = await client.query<Record<string, unknown>>(`select * from public.list_outlook_connectors(null, null, 10)`);
    const row = res.rows.find((r) => r.connector_id === id)!;
    expect(Object.keys(row).sort()).toEqual(["connector_id", "tenant_id", "user_id"]);
    expect(row).toEqual({ tenant_id: tenantA, user_id: member, connector_id: id });
    await client.exec(`reset role; DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'outsider') THEN CREATE ROLE outsider NOLOGIN; END IF; END $$; grant usage on schema public to outsider;`);
    try {
      expect((await client.query<{ ok: boolean }>(`select has_function_privilege('app_user', 'public.list_outlook_connectors(uuid, text, integer)', 'EXECUTE') as ok`)).rows[0]!.ok).toBe(true);
      expect((await client.query<{ ok: boolean }>(`select has_function_privilege('outsider', 'public.list_outlook_connectors(uuid, text, integer)', 'EXECUTE') as ok`)).rows[0]!.ok).toBe(false);
      await client.exec(`set role outsider`);
      await expect(client.query(`select * from public.list_outlook_connectors(null, null, 10)`)).rejects.toThrow(/permission denied/);
    } finally {
      await client.exec(`reset role; set role app_user;`);
    }
  });

  it("the connection generation fences cursor and time writes; a token refresh does not change it", async () => {
    const q = tenantScoped(db, tenantA).outlookConnectors;
    const c = (await q.getById(id))!;
    expect(c.connectionGeneration).toBe(1);
    expect(await q.compareAndSwapTokens(id, c.tokenVersion, bytes("t2"))).toBe(true);
    expect((await q.getById(id))!.connectionGeneration).toBe(1);
    expect(await q.updateCursor(id, 1, bytes("cur"))).toBe(true);
    expect(await q.touch(id, 1, { lastPollAt: new Date() })).toBe(true);
    expect(await q.updateCursor(id, 2, bytes("nope"))).toBe(false);
    expect(await q.touch(id, 2, { lastPollAt: new Date() })).toBe(false);
    expect(Buffer.from((await q.getById(id))!.encryptedDeltaCursor!).toString()).toBe("cur");

    const other = tenantScoped(db, tenantB).outlookConnectors; // RLS: another tenant cannot write it either
    expect(await other.updateCursor(id, 1, bytes("evil"))).toBe(false);

    expect(await q.disconnect(member)).toBe(true);
    expect((await q.getById(id))!.connectionGeneration).toBe(2);
    expect(await q.updateCursor(id, 1, bytes("late"))).toBe(false); // an in-flight poll from before the disconnect
    expect(await q.updateCursor(id, 2, bytes("late"))).toBe(false); // not connected
    expect((await q.getById(id))!.encryptedDeltaCursor).toBeUndefined();
    const again = await q.upsertConnected({ id: crypto.randomUUID(), userId: member, microsoftUserId: "ms-c", displayAddress: "c@outlook.com", encryptedTokens: bytes("t3") });
    expect(again).toMatchObject({ id, status: "connected", connectionGeneration: 3 });
    expect(await q.updateCursor(id, 1, bytes("stale"))).toBe(false);
    expect(await q.updateCursor(id, 3, bytes("ok"))).toBe(true);
  });

  it("seen messages: insert-if-absent, fenced on the connector, purge by age, cleared on disconnect, RLS", async () => {
    const q = tenantScoped(db, tenantA);
    const now = new Date();
    const gen = (await q.outlookConnectors.getById(id))!.connectionGeneration;
    expect(await q.outlookSeenMessages.claim(id, gen, "k1", now)).toBe(true);
    expect(await q.outlookSeenMessages.claim(id, gen, "k1", now)).toBe(false);
    expect(await q.outlookSeenMessages.claim(id, gen + 1, "k2", now)).toBe(false); // stale generation
    expect(await q.outlookSeenMessages.claim(id, gen, "old", new Date(now.getTime() - 50 * 86_400_000))).toBe(true);
    expect(await tenantScoped(db, tenantB).outlookSeenMessages.claim(id, gen, "x", now)).toBe(false); // other tenant: no such connector
    expect((await client.query(`select 1 from outlook_seen_messages`)).rows).toEqual([]); // no tenant context
    expect(await q.outlookSeenMessages.purge(id, new Date(now.getTime() - 45 * 86_400_000))).toBe(1);
    await q.outlookSeenMessages.release(id, "k1");
    expect(await q.outlookSeenMessages.claim(id, gen, "k1", now)).toBe(true); // released: claimable again
    expect(await q.outlookConnectors.disconnect(member)).toBe(true);
    const left = await q.transaction((t) => t.tx.execute(sql`select count(*)::int as n from outlook_seen_messages`));
    expect((left as unknown as { rows: Array<{ n: number }> }).rows[0]).toEqual({ n: 0 });
    await q.outlookConnectors.upsertConnected({ id, userId: member, microsoftUserId: "ms-c", displayAddress: "c@outlook.com", encryptedTokens: bytes("t4") });
  });

  it("findings: alerted_at is null until marked, only active unalerted rows are listed, re-activation clears it", async () => {
    const q = tenantScoped(db, tenantA).outlookRuleFindings;
    const f = await q.upsert({ userId: member, connectorId: id, ruleKey: "fk", action: "redirect_to", destinationDomain: "d.example" });
    expect((await q.listUnalerted(id)).map((x) => x.id)).toEqual([f.id]);
    const at = new Date();
    await q.markAlerted(f.id, at);
    expect(await q.listUnalerted(id)).toEqual([]);
    expect((await q.list(member, { state: "active" }))[0]!.alertedAt).toEqual(at);
    await q.resolveMissing(id, [], new Date());
    await q.upsert({ userId: member, connectorId: id, ruleKey: "fk", action: "redirect_to", destinationDomain: "d.example", now: new Date(Date.now() + 1000) });
    expect((await q.listUnalerted(id)).map((x) => x.id)).toEqual([f.id]);
  });

  it("the token refresh compare-and-swap runs against the database store (rows.length === 1)", async () => {
    const store = createDbOutlookStore(db);
    const identity = { tenantId: tenantA, userId: member, connectorId: id };
    const c = (await store.getConnectorById(tenantA, id))!;
    const expired = encryptTokens({ accessToken: "old", refreshToken: "r1", expiresAt: "2020-01-01T00:00:00Z" }, identity, {});
    expect(await store.compareAndSwapTokens(tenantA, id, c.tokenVersion, expired)).toBe(true);
    const deps = {
      store,
      source: {},
      now: () => new Date("2026-10-05T12:00:00Z"),
      oauth: { refresh: async () => ({ accessToken: "fresh", refreshToken: "r2", expiresIn: 3600 }) },
    } as unknown as OutlookDeps;
    expect(await getAccessToken(identity, deps)).toEqual({ ok: true, accessToken: "fresh" });
    const after = (await store.getConnectorById(tenantA, id))!;
    expect(after.tokenVersion).toBe(c.tokenVersion + 2); // one CAS above, one by the refresh
    // Losing the race: the refresh's CAS sees a newer version and the winner's token is used instead.
    const raced = {
      ...deps,
      oauth: { refresh: async () => {
        const cur = (await store.getConnectorById(tenantA, id))!;
        await store.compareAndSwapTokens(tenantA, id, cur.tokenVersion, encryptTokens({ accessToken: "winner", refreshToken: "r3", expiresAt: "2099-01-01T00:00:00Z" }, identity, {}));
        return { accessToken: "loser", refreshToken: "r4", expiresIn: 3600 };
      } },
      now: () => new Date("2030-01-01T00:00:00Z"),
    } as unknown as OutlookDeps;
    expect(await getAccessToken(identity, raced)).toEqual({ ok: true, accessToken: "winner" });
  });
});
