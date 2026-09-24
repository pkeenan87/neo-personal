import { sql } from "drizzle-orm";
import { check, index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
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
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "memberships_tenant_user_pk", columns: [t.tenantId, t.userId] }),
    index("memberships_user_idx").on(t.userId),
    check("memberships_role_check", sql`${t.role} in ('owner', 'member')`),
  ],
);
