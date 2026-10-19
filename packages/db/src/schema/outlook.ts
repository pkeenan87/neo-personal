import { sql } from "drizzle-orm";
import { check, customType, foreignKey, index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { memberships, tenants } from "./tenants.js";

export type OutlookConnectorStatus = "connected" | "reauth_required" | "paused" | "disconnected";
export type OutlookFindingState = "active" | "resolved";
export type OutlookFindingAction = "forward_to" | "redirect_to" | "forward_as_attachment_to";

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
  toDriver: value => Buffer.from(value),
  fromDriver: value => new Uint8Array(value),
});

/**
 * Short-lived OAuth state transaction (_specs/outlook-connector.md). Stores only a hash of `state` and the
 * encrypted PKCE verifier. Single use (`consumed_at`), 10-minute `expires_at`.
 */
export const outlookOAuthStates = pgTable("outlook_oauth_states", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  stateHash: bytea("state_hash").notNull(),
  encryptedPkceVerifier: bytea("encrypted_pkce_verifier").notNull(),
  expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { mode: "date", withTimezone: true }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
}, t => [
  foreignKey({ name: "outlook_oauth_states_membership_fk", columns: [t.tenantId, t.userId], foreignColumns: [memberships.tenantId, memberships.userId] }).onDelete("cascade"),
  uniqueIndex("outlook_oauth_states_hash_idx").on(t.stateHash),
  index("outlook_oauth_states_expires_idx").on(t.expiresAt),
]);

/**
 * One Outlook.com connection per member. Token and delta-cursor ciphertext live here (distinct HKDF labels, AAD bound to
 * tenant/user/connector); both are null once disconnected or after `reauth_required`.
 */
export const outlookConnectors = pgTable("outlook_connectors", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  microsoftUserId: text("microsoft_user_id").notNull(),
  displayAddress: text("display_address").notNull(),
  status: text("status").$type<OutlookConnectorStatus>().notNull().default("connected"),
  /** Compare-and-swap guard for token refresh. */
  tokenVersion: integer("token_version").notNull().default(1),
  /** Bumped on every (re)connect: an in-flight poll from an earlier connection cannot write cursor or times back. */
  connectionGeneration: integer("connection_generation").notNull().default(1),
  encryptedTokens: bytea("encrypted_tokens"),
  encryptedDeltaCursor: bytea("encrypted_delta_cursor"),
  lastAuditAt: timestamp("last_audit_at", { mode: "date", withTimezone: true }),
  lastPollAt: timestamp("last_poll_at", { mode: "date", withTimezone: true }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
}, t => [
  foreignKey({ name: "outlook_connectors_membership_fk", columns: [t.tenantId, t.userId], foreignColumns: [memberships.tenantId, memberships.userId] }).onDelete("cascade"),
  uniqueIndex("outlook_connectors_user_idx").on(t.tenantId, t.userId),
  uniqueIndex("outlook_connectors_tenant_id_idx").on(t.tenantId, t.id),
  check("outlook_connectors_status_check", sql`${t.status} in ('connected', 'reauth_required', 'paused', 'disconnected')`),
]);

/**
 * Forwarding-rule findings for one connector. `rule_key` is a one-way digest of (rule id, action, destination domain);
 * only the destination domain is kept, never the address or the rule JSON.
 */
export const outlookRuleFindings = pgTable("outlook_rule_findings", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  connectorId: uuid("connector_id").notNull(),
  ruleKey: text("rule_key").notNull(),
  state: text("state").$type<OutlookFindingState>().notNull().default("active"),
  action: text("action").$type<OutlookFindingAction>().notNull(),
  /** Null when the destination could not be parsed (indeterminate). */
  destinationDomain: text("destination_domain"),
  /** First observation of the current activation (reset when a resolved finding reappears). */
  observedAt: timestamp("observed_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { mode: "date", withTimezone: true }),
  /** Set only once the owner alert for this activation succeeded (or was skipped by policy); null means the audit retries it. */
  alertedAt: timestamp("alerted_at", { mode: "date", withTimezone: true }),
}, t => [
  foreignKey({ name: "outlook_rule_findings_membership_fk", columns: [t.tenantId, t.userId], foreignColumns: [memberships.tenantId, memberships.userId] }).onDelete("cascade"),
  foreignKey({ name: "outlook_rule_findings_connector_fk", columns: [t.tenantId, t.connectorId], foreignColumns: [outlookConnectors.tenantId, outlookConnectors.id] }).onDelete("cascade"),
  uniqueIndex("outlook_rule_findings_rule_idx").on(t.tenantId, t.connectorId, t.ruleKey),
  index("outlook_rule_findings_user_idx").on(t.tenantId, t.userId),
  check("outlook_rule_findings_state_check", sql`${t.state} in ('active', 'resolved')`),
  check("outlook_rule_findings_action_check", sql`${t.action} in ('forward_to', 'redirect_to', 'forward_as_attachment_to')`),
]);

/**
 * Keyed fingerprints of Graph message ids already handled for a connector, so a message re-emitted by a later delta run
 * is never processed twice. `message_key` is HMAC-SHA256(Graph message id) under a per-tenant key (never the id itself).
 * Rows older than 45 days are purged by the daily audit.
 */
export const outlookSeenMessages = pgTable("outlook_seen_messages", {
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  connectorId: uuid("connector_id").notNull(),
  messageKey: text("message_key").notNull(),
  seenAt: timestamp("seen_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
}, t => [
  primaryKey({ name: "outlook_seen_messages_pk", columns: [t.connectorId, t.messageKey] }),
  foreignKey({ name: "outlook_seen_messages_connector_fk", columns: [t.tenantId, t.connectorId], foreignColumns: [outlookConnectors.tenantId, outlookConnectors.id] }).onDelete("cascade"),
  index("outlook_seen_messages_seen_idx").on(t.connectorId, t.seenAt),
]);
