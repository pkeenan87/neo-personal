/**
 * Personal access tokens for desktop / shell clients (Omarchy plugin, future
 * Tauri app). User-owned like Auth.js `sessions`: no RLS, looked up by hash
 * before a tenant context exists. `tenant_id` and `role` are snapshotted at
 * create time from the user's current membership.
 *
 * Scopes (_specs/device-enrollment.md): a `full` token acts as the user; a monitoring
 * token belongs to one device (`device_id`) and holds `MONITORING_SCOPES` only.
 */
import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { devices } from "./devices.js";
import { tenants, type MembershipRole } from "./tenants.js";

export const TOKEN_SCOPES = ["full", "device", "signals:write", "url:check"] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

/** Every monitoring (device) token holds exactly these. */
export const MONITORING_SCOPES = ["device", "signals:write", "url:check"] as const satisfies readonly TokenScope[];

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
    scopes: text("scopes").array().$type<TokenScope[]>().notNull().default(sql`'{full}'::text[]`),
    /** Set for monitoring tokens: the device the token reports for. */
    deviceId: uuid("device_id").references(() => devices.id, { onDelete: "cascade" }),
  },
  (t) => [
    index("desktop_tokens_user_idx").on(t.userId),
    index("desktop_tokens_tenant_idx").on(t.tenantId),
    check("desktop_tokens_role_check", sql`${t.role} in ('owner', 'member')`),
    check(
      "desktop_tokens_scopes_check",
      sql`cardinality(${t.scopes}) > 0 and ${t.scopes} <@ array['full', 'device', 'signals:write', 'url:check']::text[]`,
    ),
    check("desktop_tokens_device_scope_check", sql`(${t.deviceId} is null) = ('full' = any(${t.scopes}))`),
    index("desktop_tokens_device_idx").on(t.deviceId),
  ],
);
