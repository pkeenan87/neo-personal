/**
 * Commands the server sends to a device (_specs/v2-m3-cutover.md section 4, migration 0029). Today only
 * `end_session`: the row is compiled into the device's signed policy bundle while it is pending and
 * unexpired, and the device answers with a `command_result` signal. Tenant-owned with RLS.
 */
import { sql } from "drizzle-orm";
import { boolean, check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { alerts } from "./alerts.js";
import { users } from "./auth.js";
import { devices } from "./devices.js";
import { tenants } from "./tenants.js";

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

export const DEVICE_COMMAND_KINDS = ["end_session"] as const;
export type DeviceCommandKind = (typeof DEVICE_COMMAND_KINDS)[number];

/** `confirmed` is reserved: the agent reports only the final outcome. */
export const DEVICE_COMMAND_STATUSES = ["pending", "delivered", "confirmed", "declined", "done", "failed", "expired"] as const;
export type DeviceCommandStatus = (typeof DEVICE_COMMAND_STATUSES)[number];

/** What an `end_session` command names: the tool (and the remote ID) of the session, from the incident's stored signals. */
export interface DeviceCommandPayload {
  toolId: string;
  peerId?: string;
}

export const deviceCommands = pgTable(
  "device_commands",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    alertId: uuid("alert_id").references(() => alerts.id, { onDelete: "set null" }),
    kind: text("kind").$type<DeviceCommandKind>().notNull(),
    payload: jsonb("payload").$type<DeviceCommandPayload>().notNull(),
    requiresConfirmation: boolean("requires_confirmation").notNull(),
    status: text("status").$type<DeviceCommandStatus>().notNull().default("pending"),
    requestedBy: text("requested_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { mode: "date", withTimezone: true }),
    /** What the device answered (`{ outcome, detail? }`). */
    result: jsonb("result").$type<Record<string, unknown>>(),
  },
  (t) => [
    index("device_commands_tenant_device_idx").on(t.tenantId, t.deviceId, t.status),
    check("device_commands_kind_check", sql`${t.kind} in (${inList(DEVICE_COMMAND_KINDS)})`),
    check("device_commands_status_check", sql`${t.status} in (${inList(DEVICE_COMMAND_STATUSES)})`),
  ],
);
