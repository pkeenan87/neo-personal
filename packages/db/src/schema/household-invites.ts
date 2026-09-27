/**
 * Invitations to join a household (_specs/household-invites.md). Tenant-owned
 * with RLS; the accept path finds an invite by its secret before it knows the
 * tenant through the security-definer `lookup_household_invite` function.
 * Only the SHA-256 of the secret (`neo_inv_…`) is stored.
 */
import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { tenants } from "./tenants.js";

export const HOUSEHOLD_INVITE_KINDS = ["email", "link"] as const;
export type HouseholdInviteKind = (typeof HOUSEHOLD_INVITE_KINDS)[number];

export const householdInvites = pgTable(
  "household_invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    kind: text("kind").$type<HouseholdInviteKind>().notNull(),
    /** Lowercased address for `email` invites; null for `link` invites. */
    email: text("email"),
    /** SHA-256 hex of the full secret. */
    tokenHash: text("token_hash").notNull().unique(),
    /** First 8 chars after the `neo_inv_` prefix, for list UIs and logs. */
    tokenPrefix: text("token_prefix").notNull(),
    /** Times the invite email has been sent (resend rotates the secret and bumps this). */
    sendCount: integer("send_count").notNull().default(0),
    invitedBy: text("invited_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
    acceptedBy: text("accepted_by").references(() => users.id, { onDelete: "set null" }),
    acceptedAt: timestamp("accepted_at", { mode: "date", withTimezone: true }),
    revokedAt: timestamp("revoked_at", { mode: "date", withTimezone: true }),
  },
  (t) => [
    index("household_invites_tenant_idx").on(t.tenantId, t.createdAt.desc()),
    check("household_invites_kind_check", sql`${t.kind} in ('email', 'link')`),
    check("household_invites_email_check", sql`(${t.kind} = 'email') = (${t.email} is not null)`),
  ],
);
