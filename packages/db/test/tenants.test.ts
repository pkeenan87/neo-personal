import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTenantForUser, findTenantForUser, getHouseholdName } from "../src/tenants.js";
import { auditEvents, memberships, tenants } from "../src/schema/index.js";
import { createTestDb, createUser, type TestDb } from "./helpers.js";

describe("createTenantForUser", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t.close();
  });

  it("creates a household, an owner membership and an audit event", async () => {
    const userId = await createUser(t.db, "Alice");
    const { tenantId } = await createTenantForUser(t.db, { userId, name: "Alice's household" });

    const [tenant] = await t.db.select().from(tenants).where(eq(tenants.id, tenantId));
    expect(tenant).toMatchObject({ id: tenantId, name: "Alice's household", kind: "household" });

    const members = await t.db.select().from(memberships).where(eq(memberships.tenantId, tenantId));
    expect(members).toEqual([expect.objectContaining({ tenantId, userId, role: "owner" })]);

    const events = await t.db.select().from(auditEvents).where(eq(auditEvents.tenantId, tenantId));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ userId, eventType: "tenant.created" });
  });

  it("is idempotent per user and resolvable via findTenantForUser", async () => {
    const userId = await createUser(t.db, "Bob");
    const [a, b] = await Promise.all([
      createTenantForUser(t.db, { userId, name: "Bob's" }),
      createTenantForUser(t.db, { userId, name: "Bob's again" }),
    ]);
    expect(a.tenantId).toBe(b.tenantId);
    expect(await t.db.select().from(memberships).where(eq(memberships.userId, userId))).toHaveLength(1);
    expect(await findTenantForUser(t.db, userId)).toEqual({ tenantId: a.tenantId, role: "owner" });
  });

  it("getHouseholdName reads the tenant's name by id", async () => {
    const userId = await createUser(t.db, "Carol");
    const { tenantId } = await createTenantForUser(t.db, { userId, name: "Carol's household" });
    expect(await getHouseholdName(t.db, tenantId)).toBe("Carol's household");
    expect(await getHouseholdName(t.db, "00000000-0000-4000-8000-000000000000")).toBeUndefined();
  });

  it("returns undefined for a user without a tenant", async () => {
    const userId = await createUser(t.db);
    expect(await findTenantForUser(t.db, userId)).toBeUndefined();
  });

  it("rejects a membership role outside owner|member", async () => {
    const userId = await createUser(t.db);
    const { tenantId } = await createTenantForUser(t.db, { userId, name: "X" });
    const other = await createUser(t.db);
    await expect(
      t.db.insert(memberships).values({ tenantId, userId: other, role: "admin" as never }),
    ).rejects.toThrow();
  });
});
