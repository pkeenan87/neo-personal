import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { MessageParam } from "@neo/core";
import { users } from "./auth.js";
import { tenants } from "./tenants.js";

export type TurnUsage = { input_tokens: number; output_tokens: number };

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title"),
    /** Destructive-tool confirmation awaiting the user; null when none. */
    pendingConfirmation: jsonb("pending_confirmation").$type<unknown>(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("conversations_tenant_user_updated_idx").on(t.tenantId, t.userId, t.updatedAt.desc())],
);

/** One agent turn: the MessageParam[] appended by a single runAgentLoop call. */
export const turns = pgTable(
  "turns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    messages: jsonb("messages").$type<MessageParam[]>().notNull(),
    usage: jsonb("usage").$type<TurnUsage>(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("turns_conversation_seq_uq").on(t.conversationId, t.seq),
    index("turns_tenant_idx").on(t.tenantId),
  ],
);
