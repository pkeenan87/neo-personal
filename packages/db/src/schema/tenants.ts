import { sql } from "drizzle-orm";
import { check, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { ModelFamily, RoutingPreference } from "@neo/core";
import { users } from "./auth.js";

export const TENANT_KINDS = ["household"] as const;
export type TenantKind = (typeof TENANT_KINDS)[number];

export const MEMBERSHIP_ROLES = ["owner", "member"] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

/** A tenant is a household. RLS keys on `id` (it is the tenant). */
export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  kind: text("kind").$type<TenantKind>().notNull().default("household"),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
});

export const memberships = pgTable(
  "memberships",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").$type<MembershipRole>().notNull(),
    /** Chat routing bias (Phase 2): shifts the routed tier along the family ladder. */
    routingPreference: text("routing_preference").$type<RoutingPreference>().notNull().default("balanced"),
    /** Model family the member prefers; falls back to Anthropic when not enabled. */
    modelFamily: text("model_family").$type<ModelFamily>().notNull().default("anthropic"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "memberships_tenant_user_pk", columns: [t.tenantId, t.userId] }),
    // A user belongs to exactly one household (_specs/household-invites.md).
    uniqueIndex("memberships_one_household").on(t.userId),
    check("memberships_role_check", sql`${t.role} in ('owner', 'member')`),
    check("memberships_routing_preference_check", sql`${t.routingPreference} in ('cost', 'balanced', 'intelligence')`),
    check("memberships_model_family_check", sql`${t.modelFamily} in ('anthropic', 'openai', 'kimi', 'grok')`),
  ],
);
