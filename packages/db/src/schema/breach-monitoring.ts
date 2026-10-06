import { sql } from "drizzle-orm";
import { check, customType, date, foreignKey, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { memberships, tenants } from "./tenants.js";
import { users } from "./auth.js";

export type VerificationSource = "sign_in" | "extra";
export type BreachCheckStatus = "never_checked" | "clean" | "breached" | "failed";

const encryptedBytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
  toDriver: value => Buffer.from(value),
  fromDriver: value => new Uint8Array(value),
});

export const monitoredAddresses = pgTable("monitored_addresses", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  digest: text("digest").notNull(),
  encryptedAddress: encryptedBytea("encrypted_address").notNull(),
  verificationSource: text("verification_source").$type<VerificationSource>().notNull(),
  verifiedAt: timestamp("verified_at", { mode: "date", withTimezone: true }),
  verificationTokenHash: text("verification_token_hash"),
  verificationExpiresAt: timestamp("verification_expires_at", { mode: "date", withTimezone: true }),
  verificationSendTimes: timestamp("verification_send_times", { mode: "date", withTimezone: true }).array().notNull().default(sql`'{}'::timestamptz[]`),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  lastCheckedAt: timestamp("last_checked_at", { mode: "date", withTimezone: true }),
  lastSuccessfulCheckAt: timestamp("last_successful_check_at", { mode: "date", withTimezone: true }),
  checkStatus: text("check_status").$type<BreachCheckStatus>().notNull().default("never_checked"),
}, t => [
  foreignKey({ name: "monitored_addresses_membership_fk", columns: [t.tenantId, t.userId], foreignColumns: [memberships.tenantId, memberships.userId] }).onDelete("cascade"),
  uniqueIndex("monitored_addresses_tenant_id_idx").on(t.tenantId, t.id),
  uniqueIndex("monitored_addresses_user_digest_idx").on(t.tenantId, t.userId, t.digest),
  uniqueIndex("monitored_addresses_token_hash_idx").on(t.verificationTokenHash).where(sql`${t.verificationTokenHash} IS NOT NULL`),
  index("monitored_addresses_user_idx").on(t.tenantId, t.userId),
  index("monitored_addresses_expiry_idx").on(t.verificationExpiresAt),
  check("monitored_addresses_source_check", sql`${t.verificationSource} in ('sign_in', 'extra')`),
  check("monitored_addresses_status_check", sql`${t.checkStatus} in ('never_checked', 'clean', 'breached', 'failed')`),
  check("monitored_addresses_send_times_check", sql`cardinality(${t.verificationSendTimes}) <= 3`),
  check("monitored_addresses_verification_fields_check", sql`(${t.verifiedAt} IS NOT NULL AND ${t.verificationTokenHash} IS NULL AND ${t.verificationExpiresAt} IS NULL) OR (${t.verifiedAt} IS NULL AND ((${t.verificationTokenHash} IS NULL AND ${t.verificationExpiresAt} IS NULL) OR (${t.verificationTokenHash} IS NOT NULL AND ${t.verificationExpiresAt} IS NOT NULL)))`),
  check("monitored_addresses_sign_in_verified_check", sql`${t.verificationSource} <> 'sign_in' OR ${t.verifiedAt} IS NOT NULL`),
]);

export const breachObservations = pgTable("breach_observations", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  monitoredAddressId: uuid("monitored_address_id").notNull(),
  breachName: text("breach_name").notNull(),
  breachDomain: text("breach_domain"),
  breachDate: date("breach_date", { mode: "date" }),
  addedDate: timestamp("added_date", { mode: "date", withTimezone: true }),
  dataClasses: text("data_classes").array().notNull().default(sql`'{}'::text[]`),
  firstSeenAt: timestamp("first_seen_at", { mode: "date", withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { mode: "date", withTimezone: true }).notNull(),
  retiredAt: timestamp("retired_at", { mode: "date", withTimezone: true }),
}, t => [
  foreignKey({ name: "breach_observations_address_fk", columns: [t.tenantId, t.monitoredAddressId], foreignColumns: [monitoredAddresses.tenantId, monitoredAddresses.id] }).onDelete("cascade"),
  uniqueIndex("breach_observations_address_name_idx").on(t.tenantId, t.monitoredAddressId, t.breachName),
  index("breach_observations_address_seen_idx").on(t.tenantId, t.monitoredAddressId, t.firstSeenAt.desc()),
]);

export type MonitoredAddress = typeof monitoredAddresses.$inferSelect;
export type BreachObservation = typeof breachObservations.$inferSelect;
