/**
 * Owner alerts (_specs/owner-alerts.md): things a household owner should hear
 * about a member. Tenant-owned with RLS. One row per (tenant, dedupe_key).
 * Title and body are template text; they may quote a model-written verdict
 * headline, so renderers treat them as untrusted.
 */
import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { devices } from "./devices.js";
import { tenants } from "./tenants.js";
import { verdicts } from "./verdicts.js";

export const ALERT_KINDS = [
  "member_verdict",
  "member_joined",
  "member_left",
  "device_enrolled",
  "device_offline",
  "device_removed",
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export const ALERT_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const ALERT_EMAIL_STATUSES = ["pending", "sent", "skipped", "failed"] as const;
export type AlertEmailStatus = (typeof ALERT_EMAIL_STATUSES)[number];

export const alerts = pgTable(
  "alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** The member the alert is about. */
    subjectUserId: text("subject_user_id").references(() => users.id, { onDelete: "set null" }),
    /** The monitored device the alert is about (device_* kinds). */
    deviceId: uuid("device_id").references(() => devices.id, { onDelete: "set null" }),
    kind: text("kind").$type<AlertKind>().notNull(),
    severity: text("severity").$type<AlertSeverity>().notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    verdictId: uuid("verdict_id").references(() => verdicts.id, { onDelete: "set null" }),
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
    acknowledgedAt: timestamp("acknowledged_at", { mode: "date", withTimezone: true }),
    acknowledgedBy: text("acknowledged_by").references(() => users.id, { onDelete: "set null" }),
    emailStatus: text("email_status").$type<AlertEmailStatus>().notNull().default("pending"),
    emailedAt: timestamp("emailed_at", { mode: "date", withTimezone: true }),
  },
  (t) => [
    uniqueIndex("alerts_tenant_dedupe_idx").on(t.tenantId, t.dedupeKey),
    index("alerts_tenant_created_idx").on(t.tenantId, t.createdAt.desc()),
    check(
      "alerts_kind_check",
      sql`${t.kind} in ('member_verdict', 'member_joined', 'member_left', 'device_enrolled', 'device_offline', 'device_removed')`,
    ),
    check("alerts_severity_check", sql`${t.severity} in ('low', 'medium', 'high', 'critical')`),
    check("alerts_email_status_check", sql`${t.emailStatus} in ('pending', 'sent', 'skipped', 'failed')`),
    check("alerts_title_length_check", sql`char_length(${t.title}) <= 140`),
    check("alerts_body_length_check", sql`char_length(${t.body}) <= 1000`),
  ],
);
