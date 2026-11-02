/**
 * Incident actions and the notification outbox (_specs/v2-m1-elder.md §2, §5). Both are
 * tenant-owned with RLS. An alert is the v2 "incident" (see alerts.ts).
 */
import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { alerts } from "./alerts.js";
import { tenants } from "./tenants.js";

export const INCIDENT_ACTION_KINDS = ["mark_expected", "allow_once"] as const;
export type IncidentActionKind = (typeof INCIDENT_ACTION_KINDS)[number];

export const INCIDENT_ACTION_REQUESTERS = ["agent", "admin"] as const;
export type IncidentActionRequester = (typeof INCIDENT_ACTION_REQUESTERS)[number];

export const INCIDENT_ACTION_STATUSES = ["pending", "approved", "rejected", "done", "failed"] as const;
export type IncidentActionStatus = (typeof INCIDENT_ACTION_STATUSES)[number];

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

export const incidentActions = pgTable(
  "incident_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    alertId: uuid("alert_id")
      .notNull()
      .references(() => alerts.id, { onDelete: "cascade" }),
    kind: text("kind").$type<IncidentActionKind>().notNull(),
    requestedBy: text("requested_by").$type<IncidentActionRequester>().notNull(),
    approvedBy: text("approved_by"),
    status: text("status").$type<IncidentActionStatus>().notNull().default("pending"),
    result: jsonb("result").$type<unknown>(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("incident_actions_tenant_alert_idx").on(t.tenantId, t.alertId),
    check("incident_actions_kind_check", sql`${t.kind} in (${inList(INCIDENT_ACTION_KINDS)})`),
    check("incident_actions_requested_by_check", sql`${t.requestedBy} in (${inList(INCIDENT_ACTION_REQUESTERS)})`),
    check("incident_actions_status_check", sql`${t.status} in (${inList(INCIDENT_ACTION_STATUSES)})`),
  ],
);

export const OUTBOX_CHANNELS = ["email"] as const;
export type OutboxChannel = (typeof OUTBOX_CHANNELS)[number];

export const notificationOutbox = pgTable(
  "notification_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** `alert:<alertId>:<recipientMemberId>`; one send per key. */
    idempotencyKey: text("idempotency_key").notNull().unique(),
    channel: text("channel").$type<OutboxChannel>().notNull(),
    /** The address, encrypted with the member-contact envelope (base64); see members.ts. */
    destinationCiphertext: text("destination_ciphertext").notNull(),
    template: text("template").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    alertId: uuid("alert_id").references(() => alerts.id, { onDelete: "set null" }),
    recipientMemberId: uuid("recipient_member_id"),
    recipientUserId: text("recipient_user_id"),
    attempts: integer("attempts").notNull().default(0),
    leaseUntil: timestamp("lease_until", { mode: "date", withTimezone: true }),
    sentAt: timestamp("sent_at", { mode: "date", withTimezone: true }),
    providerId: text("provider_id"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("notification_outbox_pending_idx").on(t.sentAt, t.leaseUntil).where(sql`${t.sentAt} is null`),
    index("notification_outbox_tenant_alert_idx").on(t.tenantId, t.alertId),
    check("notification_outbox_channel_check", sql`${t.channel} in (${inList(OUTBOX_CHANNELS)})`),
  ],
);
