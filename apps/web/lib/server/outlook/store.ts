/**
 * Outlook connector rows behind one seam: @neo/db (`tenantScoped(...)` tables) with a database, else the in-memory twin
 * (memory-state.ts) for MOCK_MODE and tests. The twin mirrors the DB rules: one connector per member, atomic single-use
 * state, version-guarded token swaps, and removal with the membership. Every method takes the tenant id.
 */
import { outlookScheduler, tenantScoped } from "@neo/db";
import type {
  OutlookConnector,
  OutlookConnectorSummary,
  OutlookFindingInput,
  OutlookFindingState,
  OutlookOAuthState,
  OutlookRuleFinding,
} from "@neo/db";
import { getDb } from "../db";
import { memoryState } from "../memory-state";

export type FindingWithCreated = OutlookRuleFinding & { created: boolean };

export interface OutlookStore {
  getConnector(tenantId: string, userId: string): Promise<OutlookConnector | undefined>;
  getConnectorById(tenantId: string, id: string): Promise<OutlookConnector | undefined>;
  listSummaries(tenantId: string): Promise<OutlookConnectorSummary[]>;
  upsertConnected(tenantId: string, input: { id: string; userId: string; microsoftUserId: string; displayAddress: string; encryptedTokens: Uint8Array }): Promise<OutlookConnector>;
  compareAndSwapTokens(tenantId: string, id: string, expectedVersion: number, ciphertext: Uint8Array): Promise<boolean>;
  markReauthRequired(tenantId: string, id: string, expectedVersion: number): Promise<boolean>;
  /** Fenced on `status = 'connected'` and the connection `generation` the run started with; false when the connector changed underneath. */
  updateCursor(tenantId: string, id: string, generation: number, cursorCiphertext: Uint8Array | null): Promise<boolean>;
  touch(tenantId: string, id: string, generation: number, patch: { lastAuditAt?: Date; lastPollAt?: Date }): Promise<boolean>;
  disconnect(tenantId: string, userId: string): Promise<boolean>;
  createState(tenantId: string, input: { id: string; userId: string; stateHash: Uint8Array; encryptedPkceVerifier: Uint8Array; expiresAt: Date }): Promise<OutlookOAuthState>;
  consumeState(tenantId: string, stateHash: Uint8Array, userId: string, now: Date): Promise<OutlookOAuthState | undefined>;
  purgeStates(tenantId: string, now: Date): Promise<number>;
  listFindings(tenantId: string, userId: string, opts?: { state?: OutlookFindingState }): Promise<OutlookRuleFinding[]>;
  upsertFinding(tenantId: string, input: OutlookFindingInput): Promise<FindingWithCreated>;
  resolveMissingFindings(tenantId: string, connectorId: string, activeKeys: readonly string[], now: Date): Promise<number>;
  listUnalertedFindings(tenantId: string, connectorId: string): Promise<OutlookRuleFinding[]>;
  markFindingAlerted(tenantId: string, findingId: string, at: Date): Promise<void>;
  /** Insert-if-absent of a keyed message fingerprint; true when this call recorded it (the message is new). */
  claimMessage(tenantId: string, connectorId: string, generation: number, messageKey: string, now: Date): Promise<boolean>;
  releaseMessage(tenantId: string, connectorId: string, messageKey: string): Promise<void>;
  purgeSeenMessages(tenantId: string, connectorId: string, before: Date): Promise<number>;
  /** Cross-tenant, `connected` connectors only, identifiers only (cron fan-out). */
  listConnected(input?: { cursor?: string; limit?: number }): Promise<{ items: Array<{ tenantId: string; userId: string; connectorId: string }>; nextCursor?: string }>;
}

export function createDbOutlookStore(db: NonNullable<ReturnType<typeof getDb>>): OutlookStore {
  const t = (tenantId: string) => tenantScoped(db, tenantId);
  return {
    getConnector: (tenantId, userId) => t(tenantId).outlookConnectors.get(userId),
    getConnectorById: (tenantId, id) => t(tenantId).outlookConnectors.getById(id),
    listSummaries: (tenantId) => t(tenantId).outlookConnectors.listSummaries(),
    upsertConnected: (tenantId, input) => t(tenantId).outlookConnectors.upsertConnected(input),
    compareAndSwapTokens: (tenantId, id, v, ct) => t(tenantId).outlookConnectors.compareAndSwapTokens(id, v, ct),
    markReauthRequired: (tenantId, id, v) => t(tenantId).outlookConnectors.markReauthRequired(id, v),
    updateCursor: (tenantId, id, gen, ct) => t(tenantId).outlookConnectors.updateCursor(id, gen, ct),
    touch: (tenantId, id, gen, patch) => t(tenantId).outlookConnectors.touch(id, gen, patch),
    disconnect: (tenantId, userId) => t(tenantId).outlookConnectors.disconnect(userId),
    createState: (tenantId, input) => t(tenantId).outlookOAuthStates.create(input),
    consumeState: (tenantId, hash, userId, now) => t(tenantId).outlookOAuthStates.consume(hash, userId, now),
    purgeStates: (tenantId, now) => t(tenantId).outlookOAuthStates.purge(now),
    listFindings: (tenantId, userId, opts) => t(tenantId).outlookRuleFindings.list(userId, opts),
    upsertFinding: (tenantId, input) => t(tenantId).outlookRuleFindings.upsert(input),
    resolveMissingFindings: (tenantId, connectorId, keys, now) => t(tenantId).outlookRuleFindings.resolveMissing(connectorId, keys, now),
    listUnalertedFindings: (tenantId, connectorId) => t(tenantId).outlookRuleFindings.listUnalerted(connectorId),
    markFindingAlerted: (tenantId, findingId, at) => t(tenantId).outlookRuleFindings.markAlerted(findingId, at),
    claimMessage: (tenantId, connectorId, gen, key, now) => t(tenantId).outlookSeenMessages.claim(connectorId, gen, key, now),
    releaseMessage: (tenantId, connectorId, key) => t(tenantId).outlookSeenMessages.release(connectorId, key),
    purgeSeenMessages: (tenantId, connectorId, before) => t(tenantId).outlookSeenMessages.purge(connectorId, before),
    listConnected: (input) => outlookScheduler.listConnected(db, input),
  };
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const copy = <T extends object>(v: T): T => ({ ...v });
/** The connector row, only while it is `connected` at the generation the caller started with (mirrors the DB fence). */
const writable = (tenantId: string, id: string, generation: number): OutlookConnector | undefined => {
  const c = memoryState().outlook.connectors.find((r) => r.tenantId === tenantId && r.id === id);
  return c && c.status === "connected" && c.connectionGeneration === generation ? c : undefined;
};

export const memoryOutlookStore: OutlookStore = {
  async getConnector(tenantId, userId) {
    const c = memoryState().outlook.connectors.find((r) => r.tenantId === tenantId && r.userId === userId);
    return c ? copy(c) : undefined;
  },
  async getConnectorById(tenantId, id) {
    const c = memoryState().outlook.connectors.find((r) => r.tenantId === tenantId && r.id === id);
    return c ? copy(c) : undefined;
  },
  async listSummaries(tenantId) {
    return memoryState().outlook.connectors.filter((r) => r.tenantId === tenantId).map((r) => ({ userId: r.userId, status: r.status, ...(r.lastAuditAt ? { lastAuditAt: r.lastAuditAt } : {}), ...(r.lastPollAt ? { lastPollAt: r.lastPollAt } : {}) }));
  },
  async upsertConnected(tenantId, input) {
    const o = memoryState().outlook;
    const now = new Date();
    const existing = o.connectors.find((r) => r.tenantId === tenantId && r.userId === input.userId);
    if (existing) {
      existing.microsoftUserId = input.microsoftUserId;
      existing.displayAddress = input.displayAddress;
      existing.status = "connected";
      existing.tokenVersion += 1;
      existing.connectionGeneration += 1;
      existing.encryptedTokens = input.encryptedTokens;
      delete existing.encryptedDeltaCursor;
      delete existing.lastAuditAt;
      delete existing.lastPollAt;
      existing.updatedAt = now;
      return copy(existing);
    }
    const row: OutlookConnector = { id: input.id, tenantId, userId: input.userId, microsoftUserId: input.microsoftUserId, displayAddress: input.displayAddress, status: "connected", tokenVersion: 1, connectionGeneration: 1, encryptedTokens: input.encryptedTokens, createdAt: now, updatedAt: now };
    o.connectors.push(row);
    return copy(row);
  },
  async compareAndSwapTokens(tenantId, id, expectedVersion, ciphertext) {
    const c = memoryState().outlook.connectors.find((r) => r.tenantId === tenantId && r.id === id);
    if (!c || c.tokenVersion !== expectedVersion || c.status !== "connected") return false;
    c.encryptedTokens = ciphertext;
    c.tokenVersion = expectedVersion + 1;
    c.updatedAt = new Date();
    return true;
  },
  async markReauthRequired(tenantId, id, expectedVersion) {
    const c = memoryState().outlook.connectors.find((r) => r.tenantId === tenantId && r.id === id);
    if (!c || c.tokenVersion !== expectedVersion || c.status !== "connected") return false;
    c.status = "reauth_required";
    delete c.encryptedTokens;
    delete c.encryptedDeltaCursor;
    c.tokenVersion = expectedVersion + 1;
    c.connectionGeneration += 1;
    c.updatedAt = new Date();
    return true;
  },
  async updateCursor(tenantId, id, generation, ct) {
    const c = writable(tenantId, id, generation);
    if (!c) return false;
    if (ct) c.encryptedDeltaCursor = ct;
    else delete c.encryptedDeltaCursor;
    c.updatedAt = new Date();
    return true;
  },
  async touch(tenantId, id, generation, patch) {
    const c = writable(tenantId, id, generation);
    if (!c) return false;
    if (patch.lastAuditAt) c.lastAuditAt = patch.lastAuditAt;
    if (patch.lastPollAt) c.lastPollAt = patch.lastPollAt;
    c.updatedAt = new Date();
    return true;
  },
  async disconnect(tenantId, userId) {
    const c = memoryState().outlook.connectors.find((r) => r.tenantId === tenantId && r.userId === userId);
    if (!c) return false;
    c.status = "disconnected";
    delete c.encryptedTokens;
    delete c.encryptedDeltaCursor;
    c.connectionGeneration += 1;
    c.updatedAt = new Date();
    const o = memoryState().outlook;
    o.seen = o.seen.filter((s) => s.connectorId !== c.id);
    return true;
  },
  async createState(tenantId, input) {
    const o = memoryState().outlook;
    if (o.states.some((s) => same(s.stateHash, input.stateHash))) throw new Error("duplicate oauth state");
    const row: OutlookOAuthState = { id: input.id, tenantId, userId: input.userId, stateHash: input.stateHash, encryptedPkceVerifier: input.encryptedPkceVerifier, expiresAt: input.expiresAt };
    o.states.push(row);
    return copy(row);
  },
  async consumeState(tenantId, hash, userId, now) {
    const s = memoryState().outlook.states.find((r) => r.tenantId === tenantId && r.userId === userId && same(r.stateHash, hash));
    if (!s || s.consumedAt || s.expiresAt.getTime() <= now.getTime()) return undefined;
    s.consumedAt = now;
    return copy(s);
  },
  async purgeStates(tenantId, now) {
    const o = memoryState().outlook;
    const before = o.states.length;
    o.states = o.states.filter((s) => !(s.tenantId === tenantId && (s.consumedAt || s.expiresAt.getTime() < now.getTime())));
    return before - o.states.length;
  },
  async listFindings(tenantId, userId, opts = {}) {
    return memoryState().outlook.findings.filter((f) => f.tenantId === tenantId && f.userId === userId && (!opts.state || f.state === opts.state)).map(copy);
  },
  async upsertFinding(tenantId, input) {
    const o = memoryState().outlook;
    const now = input.now ?? new Date();
    const existing = o.findings.find((f) => f.tenantId === tenantId && f.connectorId === input.connectorId && f.ruleKey === input.ruleKey);
    if (!existing) {
      const row: OutlookRuleFinding = { id: crypto.randomUUID(), tenantId, userId: input.userId, connectorId: input.connectorId, ruleKey: input.ruleKey, state: "active", action: input.action, ...(input.destinationDomain ? { destinationDomain: input.destinationDomain } : {}), observedAt: now };
      o.findings.push(row);
      return { ...row, created: true };
    }
    if (existing.state === "active") return { ...existing, created: false };
    existing.state = "active";
    existing.observedAt = now;
    delete existing.resolvedAt;
    delete existing.alertedAt;
    return { ...existing, created: true };
  },
  async resolveMissingFindings(tenantId, connectorId, activeKeys, now) {
    const keep = new Set(activeKeys);
    let n = 0;
    for (const f of memoryState().outlook.findings) {
      if (f.tenantId !== tenantId || f.connectorId !== connectorId || f.state !== "active" || keep.has(f.ruleKey)) continue;
      f.state = "resolved";
      f.resolvedAt = now;
      n++;
    }
    return n;
  },
  async listUnalertedFindings(tenantId, connectorId) {
    return memoryState().outlook.findings.filter((f) => f.tenantId === tenantId && f.connectorId === connectorId && f.state === "active" && !f.alertedAt).map(copy);
  },
  async markFindingAlerted(tenantId, findingId, at) {
    const f = memoryState().outlook.findings.find((r) => r.tenantId === tenantId && r.id === findingId);
    if (f && !f.alertedAt) f.alertedAt = at;
  },
  async claimMessage(tenantId, connectorId, generation, key, now) {
    if (!writable(tenantId, connectorId, generation)) return false;
    const o = memoryState().outlook;
    if (o.seen.some((s) => s.connectorId === connectorId && s.messageKey === key)) return false;
    o.seen.push({ tenantId, connectorId, messageKey: key, seenAt: now });
    return true;
  },
  async releaseMessage(tenantId, connectorId, key) {
    const o = memoryState().outlook;
    o.seen = o.seen.filter((s) => !(s.tenantId === tenantId && s.connectorId === connectorId && s.messageKey === key));
  },
  async purgeSeenMessages(tenantId, connectorId, before) {
    const o = memoryState().outlook;
    const n = o.seen.length;
    o.seen = o.seen.filter((s) => !(s.tenantId === tenantId && s.connectorId === connectorId && s.seenAt.getTime() < before.getTime()));
    return n - o.seen.length;
  },
  async listConnected(input = {}) {
    const limit = Math.min(1000, Math.max(1, input.limit ?? 500));
    let after: [string, string] | undefined;
    if (input.cursor) {
      const v: unknown = JSON.parse(input.cursor);
      if (Array.isArray(v) && v.length === 2) after = [String(v[0]), String(v[1])];
    }
    const rows = memoryState().outlook.connectors
      .filter((c) => c.status === "connected")
      .sort((a, b) => (a.tenantId + "\u0000" + a.userId).localeCompare(b.tenantId + "\u0000" + b.userId))
      .filter((c) => !after || (c.tenantId + "\u0000" + c.userId).localeCompare(after[0] + "\u0000" + after[1]) > 0)
      .slice(0, limit);
    const items = rows.map((c) => ({ tenantId: c.tenantId, userId: c.userId, connectorId: c.id }));
    const last = items.at(-1);
    return { items, ...(items.length === limit && last ? { nextCursor: JSON.stringify([last.tenantId, last.userId]) } : {}) };
  },
};

export function getOutlookStore(): OutlookStore {
  const db = getDb();
  return db ? createDbOutlookStore(db) : memoryOutlookStore;
}
