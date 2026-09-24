import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { auditEvents, memberships, tenants, type MembershipRole } from "./schema/index.js";
import { setTenantContext, setUserContext } from "./tenant.js";

export type UserTenant = { tenantId: string; role: MembershipRole };

/**
 * Create a household tenant with `userId` as owner, plus a `tenant.created` audit event, in
 * one transaction. Idempotent per user: if the user already owns a household (e.g. two
 * concurrent first sign-ins), that tenant is returned and nothing is written.
 */
export async function createTenantForUser(db: Db, input: { userId: string; name: string }): Promise<{ tenantId: string }> {
  const name = input.name.trim() || "My household";
  return db.transaction(async (tx) => {
    // Serialize tenant creation per user so concurrent sign-in callbacks cannot race.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"neo:create-tenant:" + input.userId}, 0))`);
    await setUserContext(tx, input.userId);

    const [existing] = await tx
      .select({ tenantId: memberships.tenantId })
      .from(memberships)
      .where(and(eq(memberships.userId, input.userId), eq(memberships.role, "owner")))
      .orderBy(asc(memberships.createdAt))
      .limit(1);
    if (existing) return { tenantId: existing.tenantId };

    const tenantId = randomUUID();
    await setTenantContext(tx, tenantId);
    await tx.insert(tenants).values({ id: tenantId, name, kind: "household" });
    await tx.insert(memberships).values({ tenantId, userId: input.userId, role: "owner" });
    await tx.insert(auditEvents).values({
      tenantId,
      userId: input.userId,
      eventType: "tenant.created",
      metadata: { kind: "household", role: "owner" },
    });
    return { tenantId };
  });
}

/**
 * Resolve the tenant a signed-in user acts in (for the Auth.js session): their oldest owner
 * membership, else their oldest membership. Runs with app.user_id set so the memberships
 * self-read RLS policy allows the lookup before the tenant is known.
 */
export async function findTenantForUser(db: Db, userId: string): Promise<UserTenant | undefined> {
  return db.transaction(async (tx) => {
    await setUserContext(tx, userId);
    const [row] = await tx
      .select({ tenantId: memberships.tenantId, role: memberships.role })
      .from(memberships)
      .where(eq(memberships.userId, userId))
      .orderBy(sql`case when ${memberships.role} = 'owner' then 0 else 1 end`, asc(memberships.createdAt))
      .limit(1);
    return row;
  });
}
