import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import type { TenantTx } from "./tenant.js";
import {
  outlookConnectors,
  outlookOAuthStates,
  outlookRuleFindings,
  outlookSeenMessages,
  type OutlookConnectorStatus,
  type OutlookFindingAction,
  type OutlookFindingState,
} from "./schema/outlook.js";

export type { OutlookConnectorStatus, OutlookFindingAction, OutlookFindingState };

export type OutlookOAuthState = { id: string; tenantId: string; userId: string; stateHash: Uint8Array; encryptedPkceVerifier: Uint8Array; expiresAt: Date; consumedAt?: Date };
export type OutlookConnector = {
  id: string;
  tenantId: string;
  userId: string;
  microsoftUserId: string;
  displayAddress: string;
  status: OutlookConnectorStatus;
  tokenVersion: number;
  /** Bumped on every connect, reconnect and disconnect; fences writes from an in-flight poll of an earlier connection. */
  connectionGeneration: number;
  encryptedTokens?: Uint8Array;
  encryptedDeltaCursor?: Uint8Array;
  lastAuditAt?: Date;
  lastPollAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};
export type OutlookRuleFinding = {
  id: string;
  tenantId: string;
  userId: string;
  connectorId: string;
  ruleKey: string;
  state: OutlookFindingState;
  action: OutlookFindingAction;
  destinationDomain?: string;
  observedAt: Date;
  resolvedAt?: Date;
  /** Set once the owner alert for this activation succeeded (or was skipped by policy). */
  alertedAt?: Date;
};
export type OutlookFindingInput = { userId: string; connectorId: string; ruleKey: string; action: OutlookFindingAction; destinationDomain?: string | undefined; now?: Date };
/** What the household owner may see about a member's connection: status and times only, never the address. */
export type OutlookConnectorSummary = { userId: string; status: OutlookConnectorStatus; lastAuditAt?: Date; lastPollAt?: Date };

type ConnectorRow = typeof outlookConnectors.$inferSelect;
type StateRow = typeof outlookOAuthStates.$inferSelect;
type FindingRow = typeof outlookRuleFindings.$inferSelect;

const bytes = (v: Uint8Array | null): Uint8Array | undefined => (v ? new Uint8Array(v) : undefined);

function connectorOf(r: ConnectorRow): OutlookConnector {
  return {
    id: r.id,
    tenantId: r.tenantId,
    userId: r.userId,
    microsoftUserId: r.microsoftUserId,
    displayAddress: r.displayAddress,
    status: r.status,
    tokenVersion: r.tokenVersion,
    connectionGeneration: r.connectionGeneration,
    ...(r.encryptedTokens ? { encryptedTokens: bytes(r.encryptedTokens)! } : {}),
    ...(r.encryptedDeltaCursor ? { encryptedDeltaCursor: bytes(r.encryptedDeltaCursor)! } : {}),
    ...(r.lastAuditAt ? { lastAuditAt: r.lastAuditAt } : {}),
    ...(r.lastPollAt ? { lastPollAt: r.lastPollAt } : {}),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function stateOf(r: StateRow): OutlookOAuthState {
  return { id: r.id, tenantId: r.tenantId, userId: r.userId, stateHash: new Uint8Array(r.stateHash), encryptedPkceVerifier: new Uint8Array(r.encryptedPkceVerifier), expiresAt: r.expiresAt, ...(r.consumedAt ? { consumedAt: r.consumedAt } : {}) };
}

function findingOf(r: FindingRow): OutlookRuleFinding {
  return {
    id: r.id, tenantId: r.tenantId, userId: r.userId, connectorId: r.connectorId, ruleKey: r.ruleKey, state: r.state, action: r.action,
    ...(r.destinationDomain ? { destinationDomain: r.destinationDomain } : {}),
    observedAt: r.observedAt,
    ...(r.resolvedAt ? { resolvedAt: r.resolvedAt } : {}),
    ...(r.alertedAt ? { alertedAt: r.alertedAt } : {}),
  };
}

export interface TenantOutlookConnectors {
  get(userId: string): Promise<OutlookConnector | undefined>;
  getById(id: string): Promise<OutlookConnector | undefined>;
  /** Status and times for every member's connector (owner view). No addresses. */
  listSummaries(): Promise<OutlookConnectorSummary[]>;
  /** Create or reconnect the member's connector: connected, new tokens, version bumped, cursor and times reset. */
  upsertConnected(input: { id: string; userId: string; microsoftUserId: string; displayAddress: string; encryptedTokens: Uint8Array }): Promise<OutlookConnector>;
  /** Replace the token ciphertext only when `token_version` still equals `expectedVersion`; bumps the version. */
  compareAndSwapTokens(id: string, expectedVersion: number, ciphertext: Uint8Array): Promise<boolean>;
  /** `invalid_grant`: drop the dead tokens and pause polling, unless another refresh already replaced them. */
  markReauthRequired(id: string, expectedVersion: number): Promise<boolean>;
  /** Only while the connector is `connected` at `generation`; false (nothing written) after a disconnect, reconnect or reauth. */
  updateCursor(id: string, generation: number, cursorCiphertext: Uint8Array | null): Promise<boolean>;
  /** Same fence as `updateCursor`. */
  touch(id: string, generation: number, patch: { lastAuditAt?: Date; lastPollAt?: Date }): Promise<boolean>;
  /** Delete token, cursor ciphertext and seen-message fingerprints and stop scheduled work. Findings stay. */
  disconnect(userId: string): Promise<boolean>;
}

export interface TenantOutlookOAuthStates {
  create(input: { id: string; userId: string; stateHash: Uint8Array; encryptedPkceVerifier: Uint8Array; expiresAt: Date }): Promise<OutlookOAuthState>;
  /** Atomic single use: succeeds once, for the owning user, before expiry. */
  consume(stateHash: Uint8Array, userId: string, now: Date): Promise<OutlookOAuthState | undefined>;
  /** Delete this tenant's expired or consumed states. */
  purge(now: Date): Promise<number>;
}

export interface TenantOutlookRuleFindings {
  list(userId: string, opts?: { state?: OutlookFindingState }): Promise<OutlookRuleFinding[]>;
  /** Activate (or re-activate) a finding. `created` is true when this is a new activation. */
  upsert(input: OutlookFindingInput): Promise<OutlookRuleFinding & { created: boolean }>;
  /** Resolve the connector's active findings whose rule key is not in `activeKeys`. */
  resolveMissing(connectorId: string, activeKeys: readonly string[], now: Date): Promise<number>;
  /** The connector's active findings whose owner alert has not succeeded yet (`alerted_at IS NULL`). */
  listUnalerted(connectorId: string): Promise<OutlookRuleFinding[]>;
  /** Record that the alert for this activation succeeded. */
  markAlerted(id: string, at: Date): Promise<void>;
}

export interface TenantOutlookSeenMessages {
  /** Insert-if-absent, only while the connector is `connected` at `generation`. True when this call recorded the key (first sight). */
  claim(connectorId: string, generation: number, messageKey: string, now: Date): Promise<boolean>;
  /** Forget a key (the message failed transiently and must be retried). */
  release(connectorId: string, messageKey: string): Promise<void>;
  /** Delete the connector's keys first seen before `before`. */
  purge(connectorId: string, before: Date): Promise<number>;
}

type Transaction = <R>(fn: (t: TenantTx) => Promise<R>) => Promise<R>;

export function createTenantOutlook(transaction: Transaction): {
  outlookConnectors: TenantOutlookConnectors;
  outlookOAuthStates: TenantOutlookOAuthStates;
  outlookRuleFindings: TenantOutlookRuleFindings;
  outlookSeenMessages: TenantOutlookSeenMessages;
} {
  /** A row is writable by a poll or audit only while it is `connected` at the generation the run started with. */
  const current = (id: string, generation: number) => and(eq(outlookConnectors.id, id), eq(outlookConnectors.status, "connected"), eq(outlookConnectors.connectionGeneration, generation))!;
  const connectors: TenantOutlookConnectors = {
    async get(userId) {
      const row = await transaction((t) => t.first(outlookConnectors, eq(outlookConnectors.userId, userId)));
      return row ? connectorOf(row) : undefined;
    },
    async getById(id) {
      const row = await transaction((t) => t.first(outlookConnectors, eq(outlookConnectors.id, id)));
      return row ? connectorOf(row) : undefined;
    },
    async listSummaries() {
      const rows = await transaction((t) => t.select(outlookConnectors));
      return rows.map((r) => ({ userId: r.userId, status: r.status, ...(r.lastAuditAt ? { lastAuditAt: r.lastAuditAt } : {}), ...(r.lastPollAt ? { lastPollAt: r.lastPollAt } : {}) }));
    },
    async upsertConnected(input) {
      return transaction(async (t) => {
        const now = new Date();
        const existing = await t.first(outlookConnectors, eq(outlookConnectors.userId, input.userId));
        if (existing) {
          const [row] = await t.update(outlookConnectors, {
            microsoftUserId: input.microsoftUserId,
            displayAddress: input.displayAddress,
            status: "connected",
            tokenVersion: existing.tokenVersion + 1,
            connectionGeneration: existing.connectionGeneration + 1,
            encryptedTokens: input.encryptedTokens,
            encryptedDeltaCursor: null,
            lastAuditAt: null,
            lastPollAt: null,
            updatedAt: now,
          }, eq(outlookConnectors.id, existing.id));
          if (!row) throw new Error("@neo/db: outlook connector update returned no row");
          return connectorOf(row);
        }
        const [row] = await t.insert(outlookConnectors, {
          id: input.id,
          userId: input.userId,
          microsoftUserId: input.microsoftUserId,
          displayAddress: input.displayAddress,
          status: "connected",
          tokenVersion: 1,
          connectionGeneration: 1,
          encryptedTokens: input.encryptedTokens,
        });
        if (!row) throw new Error("@neo/db: outlook connector insert returned no row");
        return connectorOf(row);
      });
    },
    async compareAndSwapTokens(id, expectedVersion, ciphertext) {
      const rows = await transaction((t) =>
        t.update(outlookConnectors, { encryptedTokens: ciphertext, tokenVersion: expectedVersion + 1, updatedAt: new Date() }, and(eq(outlookConnectors.id, id), eq(outlookConnectors.tokenVersion, expectedVersion), eq(outlookConnectors.status, "connected"))),
      );
      return rows.length === 1;
    },
    async markReauthRequired(id, expectedVersion) {
      const rows = await transaction((t) =>
        t.update(outlookConnectors, { status: "reauth_required", encryptedTokens: null, encryptedDeltaCursor: null, tokenVersion: expectedVersion + 1, connectionGeneration: sql`${outlookConnectors.connectionGeneration} + 1`, updatedAt: new Date() }, and(eq(outlookConnectors.id, id), eq(outlookConnectors.tokenVersion, expectedVersion), eq(outlookConnectors.status, "connected"))),
      );
      return rows.length === 1;
    },
    async updateCursor(id, generation, cursorCiphertext) {
      const rows = await transaction((t) => t.update(outlookConnectors, { encryptedDeltaCursor: cursorCiphertext, updatedAt: new Date() }, current(id, generation)));
      return rows.length === 1;
    },
    async touch(id, generation, patch) {
      const rows = await transaction((t) => t.update(outlookConnectors, { ...(patch.lastAuditAt ? { lastAuditAt: patch.lastAuditAt } : {}), ...(patch.lastPollAt ? { lastPollAt: patch.lastPollAt } : {}), updatedAt: new Date() }, current(id, generation)));
      return rows.length === 1;
    },
    async disconnect(userId) {
      return transaction(async (t) => {
        const rows = await t.update(
          outlookConnectors,
          { status: "disconnected", encryptedTokens: null, encryptedDeltaCursor: null, connectionGeneration: sql`${outlookConnectors.connectionGeneration} + 1`, updatedAt: new Date() },
          eq(outlookConnectors.userId, userId),
        );
        for (const r of rows) await t.delete(outlookSeenMessages, eq(outlookSeenMessages.connectorId, r.id));
        return rows.length > 0;
      });
    },
  };

  const states: TenantOutlookOAuthStates = {
    async create(input) {
      const [row] = await transaction((t) => t.insert(outlookOAuthStates, { id: input.id, userId: input.userId, stateHash: input.stateHash, encryptedPkceVerifier: input.encryptedPkceVerifier, expiresAt: input.expiresAt }));
      if (!row) throw new Error("@neo/db: outlook oauth state insert returned no row");
      return stateOf(row);
    },
    async consume(stateHash, userId, now) {
      const [row] = await transaction((t) =>
        t.update(outlookOAuthStates, { consumedAt: now }, and(eq(outlookOAuthStates.stateHash, stateHash), eq(outlookOAuthStates.userId, userId), isNull(outlookOAuthStates.consumedAt), gt(outlookOAuthStates.expiresAt, now))),
      );
      return row ? stateOf(row) : undefined;
    },
    async purge(now) {
      const rows = await transaction((t) => t.delete(outlookOAuthStates, sql`(${outlookOAuthStates.expiresAt} < ${now} or ${outlookOAuthStates.consumedAt} is not null)`));
      return rows.length;
    },
  };

  const findings: TenantOutlookRuleFindings = {
    async list(userId, opts = {}) {
      const where = opts.state ? and(eq(outlookRuleFindings.userId, userId), eq(outlookRuleFindings.state, opts.state)) : eq(outlookRuleFindings.userId, userId);
      const rows = await transaction((t) => t.select(outlookRuleFindings, where));
      return rows.map(findingOf);
    },
    async upsert(input) {
      return transaction(async (t) => {
        const now = input.now ?? new Date();
        const existing = await t.first(outlookRuleFindings, and(eq(outlookRuleFindings.connectorId, input.connectorId), eq(outlookRuleFindings.ruleKey, input.ruleKey)));
        if (!existing) {
          const [row] = await t.insert(outlookRuleFindings, { userId: input.userId, connectorId: input.connectorId, ruleKey: input.ruleKey, action: input.action, destinationDomain: input.destinationDomain ?? null, state: "active", observedAt: now });
          if (!row) throw new Error("@neo/db: outlook finding insert returned no row");
          return { ...findingOf(row), created: true };
        }
        if (existing.state === "active") return { ...findingOf(existing), created: false };
        const [row] = await t.update(outlookRuleFindings, { state: "active", observedAt: now, resolvedAt: null, alertedAt: null }, eq(outlookRuleFindings.id, existing.id));
        if (!row) throw new Error("@neo/db: outlook finding update returned no row");
        return { ...findingOf(row), created: true };
      });
    },
    async resolveMissing(connectorId, activeKeys, now) {
      return transaction(async (t) => {
        const active = await t.select(outlookRuleFindings, and(eq(outlookRuleFindings.connectorId, connectorId), eq(outlookRuleFindings.state, "active")));
        const keep = new Set(activeKeys);
        let n = 0;
        for (const f of active) {
          if (keep.has(f.ruleKey)) continue;
          await t.update(outlookRuleFindings, { state: "resolved", resolvedAt: now }, eq(outlookRuleFindings.id, f.id));
          n++;
        }
        return n;
      });
    },
    async listUnalerted(connectorId) {
      const rows = await transaction((t) => t.select(outlookRuleFindings, and(eq(outlookRuleFindings.connectorId, connectorId), eq(outlookRuleFindings.state, "active"), isNull(outlookRuleFindings.alertedAt))));
      return rows.map(findingOf);
    },
    async markAlerted(id, at) {
      await transaction((t) => t.update(outlookRuleFindings, { alertedAt: at }, and(eq(outlookRuleFindings.id, id), isNull(outlookRuleFindings.alertedAt))));
    },
  };

  const seen: TenantOutlookSeenMessages = {
    async claim(connectorId, generation, messageKey, now) {
      return transaction(async (t) => {
        if (!(await t.first(outlookConnectors, current(connectorId, generation)))) return false;
        const rows = await t.tx.insert(outlookSeenMessages).values({ tenantId: t.tenantId, connectorId, messageKey, seenAt: now }).onConflictDoNothing().returning({ key: outlookSeenMessages.messageKey });
        return rows.length === 1;
      });
    },
    async release(connectorId, messageKey) {
      await transaction((t) => t.delete(outlookSeenMessages, and(eq(outlookSeenMessages.connectorId, connectorId), eq(outlookSeenMessages.messageKey, messageKey))));
    },
    async purge(connectorId, before) {
      const rows = await transaction((t) => t.delete(outlookSeenMessages, and(eq(outlookSeenMessages.connectorId, connectorId), lt(outlookSeenMessages.seenAt, before))));
      return rows.length;
    },
  };

  return { outlookConnectors: connectors, outlookOAuthStates: states, outlookRuleFindings: findings, outlookSeenMessages: seen };
}

/** Cross-tenant discovery for the poll and audit crons (SECURITY DEFINER `list_outlook_connectors`). Identifiers only. */
export const outlookScheduler = {
  async listConnected(db: Db, input: { cursor?: string; limit?: number } = {}): Promise<{ items: Array<{ tenantId: string; userId: string; connectorId: string }>; nextCursor?: string }> {
    const limit = input.limit ?? 500;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid outlook connector page size");
    let cursor: [string | null, string | null] = [null, null];
    if (input.cursor) {
      const value: unknown = JSON.parse(input.cursor);
      if (!Array.isArray(value) || value.length !== 2 || value.some((part) => typeof part !== "string")) throw new Error("Invalid outlook connector cursor");
      cursor = value as [string, string];
    }
    const result = await db.execute(sql`
      SELECT tenant_id, user_id, connector_id
      FROM public.list_outlook_connectors(${cursor[0]}::uuid, ${cursor[1]}::text, ${limit}::integer)
    `);
    const rows = (result as unknown as { rows: Array<Record<string, unknown>> }).rows;
    const items = rows.map((row) => ({ tenantId: String(row.tenant_id), userId: String(row.user_id), connectorId: String(row.connector_id) }));
    const last = items.at(-1);
    return { items, ...(items.length === limit && last ? { nextCursor: JSON.stringify([last.tenantId, last.userId]) } : {}) };
  },
};
