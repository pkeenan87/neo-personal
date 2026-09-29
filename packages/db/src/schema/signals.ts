/**
 * Device signals, expected remote-access tools and the shared reputation cache
 * (_specs/signals.md). `device_signals` and `device_expected_tools` are tenant-owned with
 * RLS; `reputation_cache` is intentionally tenant-less (public reputation facts only, never
 * who asked) and carries no RLS.
 */
import { sql } from "drizzle-orm";
import { boolean, check, index, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { alerts } from "./alerts.js";
import { users } from "./auth.js";
import { devices } from "./devices.js";
import { tenants } from "./tenants.js";
import { verdicts } from "./verdicts.js";

export const SIGNAL_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type SignalSeverity = (typeof SIGNAL_SEVERITIES)[number];

export const SIGNAL_OUTCOMES = ["pending", "alerted", "recorded", "dismissed"] as const;
export type SignalOutcome = (typeof SIGNAL_OUTCOMES)[number];

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

export const MAX_EXPECTED_TOOLS = 10;
export const MAX_EXPECTED_TOOL_PEER_IDS = 10;

export const deviceSignals = pgTable(
  "device_signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    /** The member the device protects. */
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Client-generated uuid; idempotency key together with device_id. */
    clientEventId: uuid("client_event_id").notNull(),
    type: text("type").notNull(),
    detector: text("detector").notNull(),
    /** The domain, toolId or app name the event is about. */
    subject: text("subject").notNull(),
    /** The validated event, minus id/type/detector. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    severity: text("severity").$type<SignalSeverity>(),
    outcome: text("outcome").$type<SignalOutcome>().notNull().default("pending"),
    escalated: boolean("escalated").notNull().default(false),
    verdictId: uuid("verdict_id").references(() => verdicts.id, { onDelete: "set null" }),
    alertId: uuid("alert_id").references(() => alerts.id, { onDelete: "set null" }),
    observedAt: timestamp("observed_at", { mode: "date", withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("device_signals_device_event_idx").on(t.deviceId, t.clientEventId),
    index("device_signals_tenant_user_observed_idx").on(t.tenantId, t.userId, t.observedAt.desc()),
    index("device_signals_tenant_device_received_idx").on(t.tenantId, t.deviceId, t.receivedAt.desc()),
    check("device_signals_outcome_check", sql`${t.outcome} in (${inList(SIGNAL_OUTCOMES)})`),
    check("device_signals_severity_check", sql`${t.severity} is null or ${t.severity} in (${inList(SIGNAL_SEVERITIES)})`),
    check("device_signals_subject_length_check", sql`char_length(${t.subject}) <= 253`),
  ],
);

/** An owner's allow-list of remote-access tools (and known peers) for one device. */
export const deviceExpectedTools = pgTable(
  "device_expected_tools",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    toolId: text("tool_id").notNull(),
    peerIds: text("peer_ids")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.deviceId, t.toolId] }),
    index("device_expected_tools_tenant_idx").on(t.tenantId),
    check("device_expected_tools_peer_ids_cardinality_check", sql`coalesce(array_length(${t.peerIds}, 1), 0) <= 10`),
  ],
);

/**
 * Shared reputation facts (domain or hash lookups), 24h TTL, across households. No tenant_id,
 * no RLS: the table holds only public facts, never who asked.
 */
export const reputationCache = pgTable(
  "reputation_cache",
  {
    key: text("key").primaryKey(),
    value: jsonb("value").$type<unknown>().notNull(),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
  },
  (t) => [index("reputation_cache_expires_idx").on(t.expiresAt)],
);
