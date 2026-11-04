/**
 * What the eve agent remembers about a household (_specs/v2-m3-cutover.md section 3). Tenant-owned with
 * RLS. Memory is a prompt-injection persistence channel, so a row is short plain text, written only by an
 * owner (console, or the approved `remember` tool) and read back only through `recall` as evidence.
 */
import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { members } from "./members.js";
import { tenants } from "./tenants.js";

export const HOUSEHOLD_MEMORY_SOURCES = ["console", "chat"] as const;
export type HouseholdMemorySource = (typeof HOUSEHOLD_MEMORY_SOURCES)[number];

export const HOUSEHOLD_MEMORY_TEXT_MAX = 280;

export const householdMemory = pgTable(
  "household_memory",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** The member this is about; null for a fact about the whole household. */
    subjectMemberId: uuid("subject_member_id").references(() => members.id, { onDelete: "set null" }),
    text: text("text").notNull(),
    /** The owner who wrote it or approved it; null once that account is gone. */
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    source: text("source").$type<HouseholdMemorySource>().notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
  },
  (t) => [
    index("household_memory_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("household_memory_expires_idx").on(t.expiresAt),
    check("household_memory_source_check", sql`${t.source} in ('console', 'chat')`),
    check("household_memory_text_length_check", sql`char_length(${t.text}) between 1 and ${sql.raw(String(HOUSEHOLD_MEMORY_TEXT_MAX))}`),
  ],
);
