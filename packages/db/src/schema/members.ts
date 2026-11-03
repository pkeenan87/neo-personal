/**
 * Protected people (_specs/v2-m1-elder.md §2) and their layered policies (§3). `members` is
 * one row per household member, backfilled from `memberships`; `user_id` is null only for a
 * future account-less member. `policies` is append-only: a change inserts the next version.
 * Both tables are tenant-owned with RLS.
 */
import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { tenants } from "./tenants.js";

export const MEMBER_ROLES = ["owner", "adult", "child", "elder"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const PROTECTION_MODES = ["standard", "child", "elder"] as const;
export type ProtectionMode = (typeof PROTECTION_MODES)[number];

export const MEMBER_DISPLAY_NAME_MAX = 80;

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

export const members = pgTable(
  "members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    displayName: text("display_name").notNull(),
    role: text("role").$type<MemberRole>().notNull(),
    mode: text("mode").$type<ProtectionMode>().notNull().default("standard"),
    birthYear: integer("birth_year"),
    /** Other members who are told when this member is in trouble. */
    helperMemberIds: uuid("helper_member_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    /** Helper contact email, encrypted (see members.ts `encryptMemberContact`); base64. */
    contactCiphertext: text("contact_ciphertext"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("members_tenant_user_idx").on(t.tenantId, t.userId),
    index("members_tenant_idx").on(t.tenantId),
    check("members_role_check", sql`${t.role} in (${inList(MEMBER_ROLES)})`),
    check("members_mode_check", sql`${t.mode} in (${inList(PROTECTION_MODES)})`),
    check("members_display_name_length_check", sql`char_length(${t.displayName}) between 1 and ${sql.raw(String(MEMBER_DISPLAY_NAME_MAX))}`),
  ],
);

export const POLICY_SCOPES = ["household", "member", "device"] as const;
export type PolicyScope = (typeof POLICY_SCOPES)[number];

export const policies = pgTable(
  "policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    scope: text("scope").$type<PolicyScope>().notNull(),
    /** The member or device id; null for the household scope. */
    scopeId: uuid("scope_id"),
    version: integer("version").notNull(),
    /** Raw rules; validated by `PolicyRulesSchema` in @neo/core, never trusted here. */
    rules: jsonb("rules").$type<unknown>().notNull(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // scope_id is null for the household, so coalesce it to keep (scope, version) unique there.
    uniqueIndex("policies_scope_version_idx").on(
      t.tenantId,
      t.scope,
      sql`coalesce(${t.scopeId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      t.version,
    ),
    check("policies_scope_check", sql`${t.scope} in (${inList(POLICY_SCOPES)})`),
    check("policies_scope_id_check", sql`(${t.scope} = 'household') = (${t.scopeId} is null)`),
    check("policies_version_check", sql`${t.version} >= 1`),
  ],
);
