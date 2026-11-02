/**
 * Who owns each eve agent session (_specs/v2-m1-elder.md section 7). eve has no per-session access
 * list, so the channel's route auth (apps/web/agent/lib/session-owner.ts) records the creator of
 * every session here and lets only that tenant and user continue or stream it. Tenant-owned, RLS.
 */
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { tenants } from "./tenants.js";

export const eveSessions = pgTable(
  "eve_sessions",
  {
    /** The eve session id (`wrun_…`). */
    sessionId: text("session_id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("eve_sessions_tenant_user_idx").on(t.tenantId, t.userId)],
);
