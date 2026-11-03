/**
 * Child mode records (_specs/v2-m2-child.md sections 2, 3 and 8). Both tables are tenant-owned
 * with RLS. `consents` is an append-only log of the household's acknowledgements about a member's
 * monitoring. `child_requests` holds what a child asks for (more time, a site, an app); slice 3
 * adds the API, the table ships with the policy slice so the schema is settled once.
 */
import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { alerts } from "./alerts.js";
import { users } from "./auth.js";
import { devices } from "./devices.js";
import { members } from "./members.js";
import { tenants } from "./tenants.js";

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

export const CONSENT_KINDS = ["monitoring_notice", "guardian_consent", "elder_self_consent"] as const;
export type ConsentKind = (typeof CONSENT_KINDS)[number];

export const consents = pgTable(
  "consents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    kind: text("kind").$type<ConsentKind>().notNull(),
    /** The owner who gave it; null once that account is gone. */
    grantedBy: text("granted_by").references(() => users.id, { onDelete: "set null" }),
    grantedAt: timestamp("granted_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
    /** What was agreed to, minimized (for Child mode: `{ mode: "child", band }`). */
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [
    index("consents_tenant_member_idx").on(t.tenantId, t.memberId, t.grantedAt.desc()),
    check("consents_kind_check", sql`${t.kind} in (${inList(CONSENT_KINDS)})`),
  ],
);

export const CHILD_REQUEST_KINDS = ["more_time", "unblock_site", "install_app"] as const;
export type ChildRequestKind = (typeof CHILD_REQUEST_KINDS)[number];

export const CHILD_REQUEST_STATUSES = ["pending", "approved", "denied", "expired"] as const;
export type ChildRequestStatus = (typeof CHILD_REQUEST_STATUSES)[number];

export const CHILD_REQUEST_ORIGINS = ["device", "engine"] as const;
export type ChildRequestOrigin = (typeof CHILD_REQUEST_ORIGINS)[number];

export const CHILD_REQUEST_REASON_MAX = 140;

export const childRequests = pgTable(
  "child_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id").references(() => devices.id, { onDelete: "set null" }),
    kind: text("kind").$type<ChildRequestKind>().notNull(),
    /** The domain, app reference or minutes asked for; minimized. */
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    /** Written by the child: attacker-controlled text. Shown quoted, never trusted. */
    reason: text("reason"),
    status: text("status").$type<ChildRequestStatus>().notNull().default("pending"),
    decidedBy: text("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { mode: "date", withTimezone: true }),
    /** What approval gave: minutes, or the allow entry. */
    grant: jsonb("grant").$type<Record<string, unknown>>(),
    alertId: uuid("alert_id").references(() => alerts.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }),
    /** Who opened it: the child through the device API, or the policy engine (a new app). Only `device` requests count towards the per-device limits. */
    origin: text("origin").$type<ChildRequestOrigin>().notNull().default("device"),
    /** SHA-256 (hex) of the email-link token; cleared when the request is decided. The token alone decides nothing. */
    decisionTokenHash: text("decision_token_hash"),
    decisionTokenExpiresAt: timestamp("decision_token_expires_at", { mode: "date", withTimezone: true }),
  },
  (t) => [
    index("child_requests_tenant_status_created_idx").on(t.tenantId, t.status, t.createdAt),
    check("child_requests_kind_check", sql`${t.kind} in (${inList(CHILD_REQUEST_KINDS)})`),
    check("child_requests_status_check", sql`${t.status} in (${inList(CHILD_REQUEST_STATUSES)})`),
    check("child_requests_origin_check", sql`${t.origin} in (${inList(CHILD_REQUEST_ORIGINS)})`),
    check("child_requests_reason_length_check", sql`${t.reason} is null or char_length(${t.reason}) <= ${sql.raw(String(CHILD_REQUEST_REASON_MAX))}`),
  ],
);
