import { sql } from "drizzle-orm";
import { boolean, check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { artifacts } from "./artifacts.js";
import { users } from "./auth.js";
import { tenants } from "./tenants.js";
import { verdicts } from "./verdicts.js";

/**
 * A household's forward-to address (`<local_part>@<NEO_INBOUND_DOMAIN>`). At most one active
 * address per tenant; rotating deactivates the old one. Resolved before the tenant is known
 * through the security-definer function `resolve_inbound_address(text)` (see docs/rls.md).
 */
export const inboundAddresses = pgTable(
  "inbound_addresses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** "check-" + 12 lowercase Crockford base32 chars. Unique across all tenants, forever. */
    localPart: text("local_part").notNull().unique("inbound_addresses_local_part_unique"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
    rotatedAt: timestamp("rotated_at", { mode: "date", withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { mode: "date", withTimezone: true }),
  },
  (t) => [
    index("inbound_addresses_tenant_idx").on(t.tenantId),
    uniqueIndex("inbound_addresses_one_active_per_tenant").on(t.tenantId).where(sql`${t.active}`),
  ],
);

export const INBOUND_STATUSES = ["received", "analyzing", "done", "rejected", "over_cap", "failed"] as const;
export type InboundStatus = (typeof INBOUND_STATUSES)[number];

/** One inbound email delivery (webhook) and its processing state. */
export const inboundMessages = pgTable(
  "inbound_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    addressId: uuid("address_id")
      .notNull()
      .references(() => inboundAddresses.id, { onDelete: "cascade" }),
    /** Provider (Resend) email id: idempotency key for webhook retries. */
    providerMessageId: text("provider_message_id").notNull().unique("inbound_messages_provider_message_id_unique"),
    /** hashPii(lowercased envelope sender): correlation without storing the address. */
    fromAddressHash: text("from_address_hash").notNull(),
    forwarderUserId: text("forwarder_user_id").references(() => users.id, { onDelete: "set null" }),
    artifactId: uuid("artifact_id").references(() => artifacts.id, { onDelete: "set null" }),
    verdictId: uuid("verdict_id").references(() => verdicts.id, { onDelete: "set null" }),
    status: text("status").$type<InboundStatus>().notNull(),
    /** Short machine code (e.g. too_large, storage_unavailable); never message content. */
    error: text("error"),
    receivedAt: timestamp("received_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { mode: "date", withTimezone: true }),
  },
  (t) => [
    index("inbound_messages_tenant_received_idx").on(t.tenantId, t.receivedAt.desc()),
    index("inbound_messages_address_received_idx").on(t.addressId, t.receivedAt.desc()),
    check(
      "inbound_messages_status_check",
      sql`${t.status} in ('received', 'analyzing', 'done', 'rejected', 'over_cap', 'failed')`,
    ),
  ],
);
