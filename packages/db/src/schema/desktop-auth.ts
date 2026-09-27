/**
 * Pending browser sign-ins for desktop / shell clients (device authorization,
 * the shape of RFC 8628). A client creates a request and receives a secret
 * device code plus a short user code; the user approves the user code in a
 * signed-in browser; the client redeems the device code for a desktop token.
 *
 * Rows live ten minutes and are deleted when redeemed. No RLS: like Auth.js
 * sessions they are looked up before a tenant context exists. Nothing secret
 * is stored: the device code is hashed and the desktop token is minted only
 * at redemption, so an approved row never holds a usable credential.
 */
import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { tenants, type MembershipRole } from "./tenants.js";

export const DESKTOP_AUTH_STATUSES = ["pending", "approved", "denied"] as const;
export type DesktopAuthStatus = (typeof DESKTOP_AUTH_STATUSES)[number];

export const desktopAuthRequests = pgTable(
  "desktop_auth_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** `XXXX-XXXX`, shown in the terminal and typed or confirmed in the browser. */
    userCode: text("user_code").notNull().unique(),
    /** SHA-256 hex of the device code the client polls with. */
    deviceCodeHash: text("device_code_hash").notNull().unique(),
    /** Client-supplied label, e.g. "NeoShield on laptop"; becomes the desktop token's name. */
    clientName: text("client_name").notNull(),
    status: text("status").$type<DesktopAuthStatus>().notNull().default("pending"),
    /** Snapshot of the approving session; null until approved. */
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    role: text("role").$type<MembershipRole>(),
    userEmail: text("user_email"),
    userName: text("user_name"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
    decidedAt: timestamp("decided_at", { mode: "date", withTimezone: true }),
  },
  (t) => [
    index("desktop_auth_requests_expires_idx").on(t.expiresAt),
    check("desktop_auth_requests_status_check", sql`${t.status} in ('pending', 'approved', 'denied')`),
    check("desktop_auth_requests_role_check", sql`${t.role} is null or ${t.role} in ('owner', 'member')`),
  ],
);
