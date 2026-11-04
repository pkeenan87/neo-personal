import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { members } from "./members.js";
import { tenants } from "./tenants.js";

export const MEMBER_CHANNELS = ["sms"] as const;
export type MemberChannelKind = (typeof MEMBER_CHANNELS)[number];

/**
 * A messaging channel a member linked to Neo (_specs/v2-architecture.md section 4, _specs/v2-m3-cutover.md
 * section 5). `platform_id` is the E.164 number for SMS. A row is trusted only once `verified_at` is set,
 * by a one-time code sent over the channel; the code is stored as a keyed hash with an expiry and a
 * persisted attempt counter. The Twilio channel resolves a sender to a member only through
 * `lookup_member_channel()` (migration 0026), which returns verified rows only.
 */
export const memberChannels = pgTable(
  "member_channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    memberId: uuid("member_id").notNull().references(() => members.id, { onDelete: "cascade" }),
    channel: text("channel").$type<MemberChannelKind>().notNull(),
    platformId: text("platform_id").notNull(),
    verifiedAt: timestamp("verified_at", { mode: "date", withTimezone: true }),
    verificationCodeHash: text("verification_code_hash"),
    verificationExpiresAt: timestamp("verification_expires_at", { mode: "date", withTimezone: true }),
    verificationAttempts: integer("verification_attempts").notNull().default(0),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("member_channels_channel_check", sql`${t.channel} in ('sms')`),
    // One verified owner per number across all households; unverified claims may coexist.
    uniqueIndex("member_channels_verified_idx").on(t.channel, t.platformId).where(sql`${t.verifiedAt} is not null`),
    uniqueIndex("member_channels_member_idx").on(t.tenantId, t.memberId, t.channel, t.platformId),
    index("member_channels_tenant_member_idx").on(t.tenantId, t.memberId),
  ],
);
