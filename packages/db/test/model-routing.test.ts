import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Route } from "@neo/core";
import type { Db } from "../src/client.js";
import { createConversationStore } from "../src/conversation-store.js";
import * as schema from "../src/schema/index.js";
import { memberships, turns, usageEvents } from "../src/schema/index.js";
import { tenantScoped } from "../src/tenant.js";
import { createTenantForUser } from "../src/tenants.js";
import { usage } from "../src/usage.js";
import { becomeAppUser, createUser } from "./helpers.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const TENANT = "11111111-1111-4111-8111-111111111111";

const routeA: Route = {
  tier: "medium",
  family: "anthropic",
  model: "claude-sonnet-5",
  displayName: "Sonnet 5",
  effort: "medium",
  preference: "balanced",
  router: "rule",
  signals: { reason: "question" },
};
const routeB: Route = { ...routeA, tier: "large", model: "claude-opus-5", displayName: "Opus 5", router: "jev" };

describe("migration 0004_model_routing", () => {
  const dir = mkdtempSync(join(tmpdir(), "neo-mig4-"));
  const client = new PGlite();
  const pg = drizzle({ client, schema });
  const db = pg as unknown as Db;
  let tenantA: string;
  let tenantB: string;
  let userA: string;
  let userA2: string;
  let userB: string;

  beforeAll(async () => {
    // Apply up to 0003, seed rows, then apply 0004 on top (an existing deployment).
    cpSync(migrationsFolder, dir, { recursive: true });
    const journalPath = join(dir, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: Array<{ tag: string }> };
    journal.entries = journal.entries.filter((e) => e.tag < "0004");
    writeFileSync(journalPath, JSON.stringify(journal));
    await migrate(pg, { migrationsFolder: dir });
    await client.exec(`
      insert into users (id, name, email) values ('u0', 'U', 'u0@example.test');
      insert into tenants (id, name) values ('${TENANT}', 'T');
      insert into memberships (tenant_id, user_id, role) values ('${TENANT}', 'u0', 'owner');
      insert into usage_events (tenant_id, user_id, model) values ('${TENANT}', 'u0', 'claude-opus-5');
    `);
    await migrate(pg, { migrationsFolder });

    userA = await createUser(db, "A");
    userA2 = await createUser(db, "A2");
    userB = await createUser(db, "B");
    ({ tenantId: tenantA } = await createTenantForUser(db, { userId: userA, name: "A" }));
    ({ tenantId: tenantB } = await createTenantForUser(db, { userId: userB, name: "B" }));
    await tenantScoped(db, tenantA).insert(memberships, { userId: userA2, role: "member" });
  });
  afterAll(async () => {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("backfills defaults on existing rows and enforces the check constraints", async () => {
    const m = await client.query<{ routing_preference: string; model_family: string }>(
      `select routing_preference, model_family from memberships where user_id = 'u0'`,
    );
    expect(m.rows).toEqual([{ routing_preference: "balanced", model_family: "anthropic" }]);
    const u = await client.query<{ tier: string | null }>(`select tier from usage_events where user_id = 'u0'`);
    expect(u.rows).toEqual([{ tier: null }]);

    await expect(client.exec(`update memberships set routing_preference = 'cheap' where user_id = 'u0'`)).rejects.toThrow(
      /memberships_routing_preference_check/,
    );
    await expect(client.exec(`update memberships set model_family = 'gemini' where user_id = 'u0'`)).rejects.toThrow(
      /memberships_model_family_check/,
    );
    await expect(client.exec(`update usage_events set tier = 'huge' where user_id = 'u0'`)).rejects.toThrow(
      /usage_events_tier_check/,
    );
  });

  describe("as the app_user role (RLS applies)", () => {
    beforeAll(async () => {
      await becomeAppUser(client);
    });
    afterAll(async () => {
      await client.exec("reset role");
    });

    it("runs as app_user", async () => {
      const { rows } = await client.query<{ role: string }>("select current_user as role");
      expect(rows[0]?.role).toBe("app_user");
    });

    it("returns default preferences, and defaults for a user without a membership in the tenant", async () => {
      expect(await tenantScoped(db, tenantA).memberships.getPreferences(userA)).toEqual({
        routingPreference: "balanced",
        modelFamily: "anthropic",
      });
      expect(await tenantScoped(db, tenantA).memberships.getPreferences(userB)).toEqual({
        routingPreference: "balanced",
        modelFamily: "anthropic",
      });
    });

    it("round-trips preferences, patching only the given fields and only the caller's row", async () => {
      const a = tenantScoped(db, tenantA).memberships;
      expect(await a.setPreferences(userA, { routingPreference: "cost" })).toEqual({
        routingPreference: "cost",
        modelFamily: "anthropic",
      });
      expect(await a.setPreferences(userA, { modelFamily: "openai" })).toEqual({
        routingPreference: "cost",
        modelFamily: "openai",
      });
      expect(await a.setPreferences(userA, {})).toEqual({ routingPreference: "cost", modelFamily: "openai" });
      expect(await a.getPreferences(userA)).toEqual({ routingPreference: "cost", modelFamily: "openai" });
      // Another member of the same household is untouched.
      expect(await a.getPreferences(userA2)).toEqual({ routingPreference: "balanced", modelFamily: "anthropic" });
    });

    it("rejects unknown values and users outside the tenant", async () => {
      const a = tenantScoped(db, tenantA).memberships;
      await expect(a.setPreferences(userA, { routingPreference: "cheap" as never })).rejects.toThrow(/routing preference/);
      await expect(a.setPreferences(userA, { modelFamily: "gemini" as never })).rejects.toThrow(/model family/);
      // userB's membership lives in tenant B: tenant A's helper cannot reach it.
      await expect(a.setPreferences(userB, { routingPreference: "intelligence" })).rejects.toThrow(/membership not found/);
      expect(await tenantScoped(db, tenantB).memberships.getPreferences(userB)).toEqual({
        routingPreference: "balanced",
        modelFamily: "anthropic",
      });
    });

    it("stores the route on the turn and returns the latest one as lastRoute", async () => {
      const store = createConversationStore(db);
      const { id } = await store.create({ tenantId: tenantA, userId: userA });
      await store.appendTurn(id, tenantA, { messages: [{ role: "user", content: "hi" }] });
      expect(await store.get(id, tenantA)).not.toHaveProperty("lastRoute");

      await store.appendTurn(id, tenantA, { messages: [{ role: "user", content: "a" }], route: routeA });
      await store.appendTurn(id, tenantA, { messages: [{ role: "user", content: "b" }], route: routeB });
      // A later turn without a route (e.g. a legacy writer) does not hide the last recorded one.
      await store.appendTurn(id, tenantA, { messages: [{ role: "user", content: "c" }] });

      const got = await store.get(id, tenantA);
      expect(got?.lastRoute).toEqual(routeB);
      expect(got?.messages).toHaveLength(4);

      const rows = await tenantScoped(db, tenantA).select(turns, eq(turns.conversationId, id), { orderBy: [asc(turns.seq)] });
      expect(rows.map((r) => r.route)).toEqual([null, routeA, routeB, null]);
      expect(await store.get(id, tenantB)).toBeUndefined();
    });

    it("records the tier on usage events", async () => {
      await usage.recordCheck(db, {
        tenantId: tenantA,
        userId: userA,
        model: "anthropic/claude-sonnet-5",
        inputTokens: 10,
        outputTokens: 5,
        tier: "medium",
      });
      await usage.recordCheck(db, { tenantId: tenantA, userId: userA, model: "claude-opus-5", inputTokens: 1, outputTokens: 1 });
      const rows = await tenantScoped(db, tenantA).select(usageEvents, eq(usageEvents.userId, userA));
      expect(rows.map((r) => [r.model, r.tier]).sort()).toEqual([
        ["anthropic/claude-sonnet-5", "medium"],
        ["claude-opus-5", null],
      ]);
    });
  });
});
