import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { conversations } from "./conversations.js";
import { tenants } from "./tenants.js";

export const USAGE_KINDS = ["check", "resume"] as const;
/** `check`: one POST /api/agent turn (counts toward the monthly cap). `resume`: a confirm resumption (tokens only). */
export type UsageKind = (typeof USAGE_KINDS)[number];

/** One row per metered agent run. Drives the per-tenant usage caps. */
export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    kind: text("kind").$type<UsageKind>().notNull().default("check"),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheCreationTokens: integer("cache_creation_tokens").notNull().default(0),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("usage_events_tenant_created_idx").on(t.tenantId, t.createdAt),
    check("usage_events_kind_check", sql`${t.kind} in ('check', 'resume')`),
  ],
);
