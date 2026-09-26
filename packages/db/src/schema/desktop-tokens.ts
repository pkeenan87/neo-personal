/**
 * Personal access tokens for desktop / shell clients (Omarchy plugin, future
 * Tauri app). User-owned like Auth.js `sessions`: no RLS, looked up by hash
 * before a tenant context exists. `tenant_id` and `role` are snapshotted at
 * create time from the user's current membership.
 */
import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { tenants, type MembershipRole } from "./tenants.js";

export const desktopTokens = pgTable(
  "desktop_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    role: text("role").$type<MembershipRole>().notNull(),
    /** Short label the user chose ("Omarchy bar", "laptop"). */
    name: text("name").notNull(),
    /** SHA-256 hex of the full token string (`neo_dt_…`). */
    tokenHash: text("token_hash").notNull().unique(),
    /** First 8 chars after the `neo_dt_` prefix, for list UIs. */
    tokenPrefix: text("token_prefix").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { mode: "date", withTimezone: true }),
    revokedAt: timestamp("revoked_at", { mode: "date", withTimezone: true }),
  },
  (t) => [
    index("desktop_tokens_user_idx").on(t.userId),
    index("desktop_tokens_tenant_idx").on(t.tenantId),
    check("desktop_tokens_role_check", sql`${t.role} in ('owner', 'member')`),
  ],
);
