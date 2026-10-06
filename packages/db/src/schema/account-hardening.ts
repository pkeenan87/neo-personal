import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { memberships } from "./tenants.js";

/**
 * A member's self-attested hardening answer (_specs/hardening-score.md). `value` is `true`/`false` or
 * `not_applicable` (`not_applicable = true`, then `answer` is null). Deleted with the membership.
 */
export const accountHardeningAnswers = pgTable("account_hardening_answers", {
  tenantId: uuid("tenant_id").notNull(),
  userId: text("user_id").notNull(),
  itemId: text("item_id").notNull(),
  answer: boolean("answer"),
  notApplicable: boolean("not_applicable").notNull().default(false),
  checklistVersion: text("checklist_version").notNull(),
  answeredAt: timestamp("answered_at", { mode: "date", withTimezone: true }).notNull(),
}, t => [
  primaryKey({ name: "account_hardening_answers_pk", columns: [t.tenantId, t.userId, t.itemId] }),
  foreignKey({ name: "account_hardening_answers_membership_fk", columns: [t.tenantId, t.userId], foreignColumns: [memberships.tenantId, memberships.userId] }).onDelete("cascade"),
  check("account_hardening_answers_item_check", sql`${t.itemId} in ('primary_email_2fa', 'passkey_or_hardware_key', 'recovery_contacts_current', 'password_manager', 'carrier_port_out_pin', 'credit_freeze', 'os_browser_auto_update', 'desktop_agent_enrolled')`),
  check("account_hardening_answers_value_check", sql`(${t.notApplicable} and ${t.answer} is null) or (not ${t.notApplicable} and ${t.answer} is not null)`),
  check("account_hardening_answers_na_check", sql`not ${t.notApplicable} or ${t.itemId} in ('credit_freeze', 'carrier_port_out_pin', 'desktop_agent_enrolled')`),
  check("account_hardening_answers_desktop_na_only_check", sql`${t.itemId} <> 'desktop_agent_enrolled' or ${t.notApplicable}`),
]);
