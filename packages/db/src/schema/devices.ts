/**
 * Monitored devices and their one-time enrollment codes (_specs/device-enrollment.md).
 * Both tables are tenant-owned with RLS. Redemption finds a code by its hash before it
 * knows the tenant through the security-definer `lookup_device_enrollment_code`.
 * Only the SHA-256 of an enrollment code is stored.
 */
import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { tenants } from "./tenants.js";

export const DEVICE_KINDS = ["browser_extension", "desktop_agent"] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

export const DEVICE_PLATFORMS = ["chrome", "edge", "firefox", "windows", "macos", "linux"] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

export const DEVICE_ENROLLMENTS = ["code", "self"] as const;
export type DeviceEnrollment = (typeof DEVICE_ENROLLMENTS)[number];

export const devices = pgTable(
  "devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** The member the device protects. */
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").$type<DeviceKind>().notNull(),
    platform: text("platform").$type<DevicePlatform>().notNull(),
    /** Client-supplied label, e.g. "Chrome on Grandma's laptop"; the owner can rename it. */
    name: text("name").notNull(),
    clientVersion: text("client_version").notNull(),
    enrolledBy: text("enrolled_by").references(() => users.id, { onDelete: "set null" }),
    enrollment: text("enrollment").$type<DeviceEnrollment>().notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { mode: "date", withTimezone: true }),
    offlineAlertedAt: timestamp("offline_alerted_at", { mode: "date", withTimezone: true }),
    revokedAt: timestamp("revoked_at", { mode: "date", withTimezone: true }),
    revokedBy: text("revoked_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    index("devices_tenant_user_idx").on(t.tenantId, t.userId),
    index("devices_active_last_seen_idx").on(t.lastSeenAt).where(sql`${t.revokedAt} is null`),
    check("devices_kind_check", sql`${t.kind} in ('browser_extension', 'desktop_agent')`),
    check("devices_platform_check", sql`${t.platform} in ('chrome', 'edge', 'firefox', 'windows', 'macos', 'linux')`),
    check("devices_enrollment_check", sql`${t.enrollment} in ('code', 'self')`),
    check("devices_name_length_check", sql`char_length(${t.name}) between 1 and 64`),
    check("devices_client_version_length_check", sql`char_length(${t.clientVersion}) between 1 and 32`),
  ],
);

export const deviceEnrollmentCodes = pgTable(
  "device_enrollment_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** The member the enrolled device will protect. */
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** SHA-256 hex of the canonical `XXXX-XXXX-XXXX` code. */
    codeHash: text("code_hash").notNull().unique(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
    redeemedAt: timestamp("redeemed_at", { mode: "date", withTimezone: true }),
    deviceId: uuid("device_id").references(() => devices.id, { onDelete: "set null" }),
    revokedAt: timestamp("revoked_at", { mode: "date", withTimezone: true }),
  },
  (t) => [index("device_enrollment_codes_tenant_idx").on(t.tenantId, t.createdAt.desc())],
);
