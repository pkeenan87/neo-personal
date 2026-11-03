/**
 * Signed policy bundles (_specs/v2-m2-child.md section 4, migration 0022). One row per device: the
 * last bundle the server compiled and signed for it, kept so the signing key (Vercel KMS) is called
 * only when the policy changes or the bundle nears expiry. Tenant-owned with RLS. `bundle` is the
 * exact JSON that was signed (the signature is over its canonical form); the row goes with the device.
 */
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { devices } from "./devices.js";
import { tenants } from "./tenants.js";

export const policyBundles = pgTable(
  "policy_bundles",
  {
    deviceId: uuid("device_id")
      .primaryKey()
      .references(() => devices.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Hex SHA-256 of the bundle body without issuedAt/expiresAt/policyVersion. */
    policyVersion: text("policy_version").notNull(),
    bundle: jsonb("bundle").$type<Record<string, unknown>>().notNull(),
    /** base64url of the raw 64-byte ES256 signature (r || s). */
    sig: text("sig").notNull(),
    keyId: text("key_id").notNull(),
    issuedAt: timestamp("issued_at", { mode: "date", withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
  },
  (t) => [index("policy_bundles_tenant_idx").on(t.tenantId)],
);
