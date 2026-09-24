import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConversationStore } from "../src/conversation-store.js";
import { auditEvents, conversations } from "../src/schema/index.js";
import { tenantScoped } from "../src/tenant.js";
import { createTenantForUser, findTenantForUser } from "../src/tenants.js";
import { createTestDb, createUser, type TestDb } from "./helpers.js";

const TENANT_OWNED = ["tenants", "memberships", "conversations", "turns", "verdicts", "artifacts", "audit_events", "usage_events"];

describe("RLS", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t.close();
  });

  it("enables RLS with an app.tenant_id policy on every tenant-owned table", async () => {
    const enabled = await t.client.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'`,
    );
    const rls = new Map(enabled.rows.map((r) => [r.relname, r.relrowsecurity]));
    for (const table of TENANT_OWNED) expect(rls.get(table), table).toBe(true);
    for (const table of ["users", "accounts", "sessions", "verification_tokens", "authenticators"]) {
      expect(rls.get(table), table).toBe(false);
    }

    const policies = await t.client.query<{ tablename: string; policyname: string; qual: string | null }>(
      `select tablename, policyname, qual from pg_policies where schemaname = 'public'`,
    );
    for (const table of TENANT_OWNED) {
      const p = policies.rows.find((r) => r.tablename === table && r.policyname === "tenant_isolation");
      expect(p, table).toBeDefined();
      expect(p!.qual).toContain("current_setting('app.tenant_id'::text, true)");
    }
  });

  describe("as a non-owner app role", () => {
    let tenantA: string;
    let tenantB: string;
    let userA: string;
    let convoA: string;

    beforeAll(async () => {
      userA = await createUser(t.db, "A");
      const userB = await createUser(t.db, "B");
      ({ tenantId: tenantA } = await createTenantForUser(t.db, { userId: userA, name: "A" }));
      ({ tenantId: tenantB } = await createTenantForUser(t.db, { userId: userB, name: "B" }));
      ({ id: convoA } = await createConversationStore(t.db).create({ tenantId: tenantA, userId: userA }));

      // Mirrors sql/create-app-user.sql (minus LOGIN/password, not needed for SET ROLE).
      await t.client.exec(`
        create role app_user nologin nobypassrls;
        grant usage on schema public to app_user;
        grant select, insert, update, delete on all tables in schema public to app_user;
        set role app_user;
      `);
    });
    afterAll(async () => {
      await t.client.exec("reset role");
    });

    it("sees no tenant rows without app.tenant_id", async () => {
      expect(await t.db.select().from(conversations)).toEqual([]);
    });

    it("hides another tenant's rows even from an unfiltered raw query", async () => {
      const rows = await tenantScoped(t.db, tenantB).transaction((s) => s.tx.select().from(conversations));
      expect(rows).toEqual([]);
      const own = await tenantScoped(t.db, tenantA).transaction((s) =>
        s.tx.select().from(conversations).where(eq(conversations.id, convoA)),
      );
      expect(own).toHaveLength(1);
    });

    it("rejects writing a row into another tenant", async () => {
      await expect(
        tenantScoped(t.db, tenantB).transaction((s) =>
          s.tx.insert(conversations).values({ tenantId: tenantA, userId: userA }),
        ),
      ).rejects.toThrow();
    });

    it("still supports the full app flow (signup, store, lookup)", async () => {
      const userC = await createUser(t.db, "C"); // users (Auth.js) has no RLS
      await t.db.insert(auditEvents).values({ eventType: "auth.signin_failed" }); // tenant-less audit insert

      const { tenantId } = await createTenantForUser(t.db, { userId: userC, name: "C" });
      expect(await findTenantForUser(t.db, userC)).toEqual({ tenantId, role: "owner" });

      const store = createConversationStore(t.db);
      const { id } = await store.create({ tenantId, userId: userC });
      await store.appendTurn(id, tenantId, { messages: [{ role: "user", content: "hi" }] });
      expect((await store.get(id, tenantId))?.messages).toHaveLength(1);
      expect(await store.get(id, tenantB)).toBeUndefined();

      const { rows } = await t.client.query<{ role: string }>("select current_user as role");
      const [row] = rows;
      expect(row?.role).toBe("app_user");
    });
  });
});
