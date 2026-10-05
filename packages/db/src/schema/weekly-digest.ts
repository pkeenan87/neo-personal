import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenants } from "./tenants.js";
import { users } from "./auth.js";
export type DigestDeliveryState = "sending" | "sent" | "empty" | "failed";
export const digestDeliveries = pgTable("digest_deliveries", {
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  isoWeek: text("iso_week").notNull(),
  state: text("state").$type<DigestDeliveryState>().notNull(),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  runId: text("run_id"),
  providerMessageId: text("provider_message_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("digest_deliveries_user_week_idx").on(t.userId, t.isoWeek),
  check("digest_deliveries_state_check", sql`${t.state} in ('sending', 'sent', 'empty', 'failed')`)]);
