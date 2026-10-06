import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { memberships, tenants } from "./tenants.js";
import { verdicts } from "./verdicts.js";

export type SigninEventSource = "forwarded" | "outlook";

/**
 * Facts parsed from a provider sign-in alert a member supplied (_specs/signin-alerts.md). Visible to the
 * member only (owners get the resulting alert, never this list). Deleted with the membership, and with the
 * verdict it came from.
 */
export const signinEvents = pgTable("signin_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  provider: text("provider").notNull(),
  event: text("event").notNull(),
  /** Sanitized label from the alert; null when the alert named no device. */
  deviceLabel: text("device_label"),
  coarseLocation: text("coarse_location"),
  /** The time stated in the alert (UTC), when unambiguous. */
  eventTime: timestamp("event_time", { mode: "date", withTimezone: true }),
  source: text("source").$type<SigninEventSource>().notNull(),
  /** dkim=pass on a provider-allowlisted domain. Unauthenticated events never raise a member verdict. */
  authenticated: boolean("authenticated").notNull(),
  verdictId: uuid("verdict_id").references(() => verdicts.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
}, t => [
  foreignKey({ name: "signin_events_membership_fk", columns: [t.tenantId, t.userId], foreignColumns: [memberships.tenantId, memberships.userId] }).onDelete("cascade"),
  index("signin_events_user_created_idx").on(t.tenantId, t.userId, t.createdAt.desc()),
  index("signin_events_verdict_idx").on(t.verdictId),
  check("signin_events_provider_check", sql`${t.provider} in ('google', 'microsoft', 'apple', 'meta', 'amazon', 'paypal')`),
  check("signin_events_event_check", sql`${t.event} in ('new_signin', 'new_device', 'password_changed', 'mfa_or_recovery_changed', 'suspicious_activity')`),
  check("signin_events_source_check", sql`${t.source} in ('forwarded', 'outlook')`),
]);

/** Provider/device pairs a member answered "yes, that was me" for. */
export const knownSigninDevices = pgTable("known_signin_devices", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  provider: text("provider").notNull(),
  deviceLabel: text("device_label").notNull(),
  firstSeenAt: timestamp("first_seen_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
}, t => [
  foreignKey({ name: "known_signin_devices_membership_fk", columns: [t.tenantId, t.userId], foreignColumns: [memberships.tenantId, memberships.userId] }).onDelete("cascade"),
  uniqueIndex("known_signin_devices_pair_idx").on(t.tenantId, t.userId, t.provider, t.deviceLabel),
  check("known_signin_devices_provider_check", sql`${t.provider} in ('google', 'microsoft', 'apple', 'meta', 'amazon', 'paypal')`),
]);
