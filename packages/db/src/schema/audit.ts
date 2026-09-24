import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { tenants } from "./tenants.js";

/**
 * Security-relevant events. tenant_id/user_id are nullable so pre-tenant events
 * (e.g. failed sign-in) can be recorded. Keep metadata free of raw PII.
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    eventType: text("event_type").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_events_tenant_created_idx").on(t.tenantId, t.createdAt.desc()),
    index("audit_events_type_created_idx").on(t.eventType, t.createdAt.desc()),
  ],
);
