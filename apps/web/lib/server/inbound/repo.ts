/**
 * Inbound persistence for the app: @neo/db `inbound` when DATABASE_URL is set,
 * else the in-memory fallback (MOCK_MODE / tests). Verdicts, members and
 * artifacts go through the app-wide paths (lib/server/verdicts.ts,
 * lib/server/memory-state.ts, lib/server/artifacts.ts), so inbound results
 * land where the dashboard reads them.
 */
import {
  inbound,
  listMembers,
  type ArtifactStore,
  type Db,
  type HouseholdMember,
  type InboundMessagePatch,
  type InboundMessageRow,
  type RecordMessageInput,
} from "@neo/db";
import { getArtifactStore } from "../artifacts";
import { getDb } from "../db";
import { memoryListMembers } from "../memory-state";
import { saveVerdict, type SaveVerdictInput } from "../verdicts";
import { memoryInbound } from "./memory";

export type { HouseholdMember, InboundMessagePatch, InboundMessageRow };

export interface InboundRepo {
  ensureAddress(tenantId: string): Promise<{ id: string; localPart: string }>;
  rotateAddress(tenantId: string): Promise<{ id: string; localPart: string }>;
  findActiveByLocalPart(localPart: string): Promise<{ id: string; tenantId: string } | undefined>;
  /** Idempotent on `providerMessageId`: a repeat returns the existing id with `duplicate: true`. */
  recordMessage(input: RecordMessageInput): Promise<{ id: string; duplicate: boolean }>;
  updateMessage(id: string, tenantId: string, patch: InboundMessagePatch): Promise<void>;
  countRecent(tenantId: string, addressId: string, windowMs: number): Promise<number>;
  listRecent(tenantId: string, limit: number): Promise<InboundMessageRow[]>;
  findMessage(id: string, tenantId: string): Promise<InboundMessageRow | undefined>;
  /** Delete rejected/failed rows older than `olderThanDays`, across tenants (retention job). */
  purgeOld(olderThanDays: number): Promise<number>;
  listMembers(tenantId: string): Promise<HouseholdMember[]>;
  saveVerdict(input: Omit<SaveVerdictInput, "conversationId">): Promise<{ id: string }>;
  /** The app's artifact store, or null when artifacts are unconfigured. */
  artifacts: ArtifactStore | null;
}

function fromDb(db: Db): InboundRepo {
  return {
    ensureAddress: (t) => inbound.ensureAddress(db, t),
    rotateAddress: (t) => inbound.rotateAddress(db, t),
    findActiveByLocalPart: (lp) => inbound.findActiveByLocalPart(db, lp),
    recordMessage: (input) => inbound.recordMessage(db, input),
    updateMessage: (id, t, patch) => inbound.updateMessage(db, id, t, patch),
    countRecent: (t, a, w) => inbound.countRecent(db, t, a, w),
    listRecent: (t, n) => inbound.listRecent(db, t, n),
    findMessage: (id, t) => inbound.getMessage(db, id, t),
    purgeOld: (days) => inbound.purgeOld(db, days),
    listMembers: (t) => listMembers(db, t),
    saveVerdict: (input) => saveVerdict(input),
    artifacts: getArtifactStore(),
  };
}

function fromMemory(): InboundRepo {
  return {
    ensureAddress: memoryInbound.ensureAddress,
    rotateAddress: memoryInbound.rotateAddress,
    findActiveByLocalPart: memoryInbound.findActiveByLocalPart,
    recordMessage: memoryInbound.recordMessage,
    updateMessage: memoryInbound.updateMessage,
    countRecent: memoryInbound.countRecent,
    listRecent: memoryInbound.listRecent,
    findMessage: memoryInbound.getMessage,
    purgeOld: memoryInbound.purgeOld,
    listMembers: async (t) => memoryListMembers(t),
    saveVerdict: (input) => saveVerdict(input),
    artifacts: getArtifactStore(),
  };
}

export function inboundRepo(db: Db | null = getDb()): InboundRepo {
  return db ? fromDb(db) : fromMemory();
}

/** True for a Postgres unique violation (e.g. a provider_message_id race). */
export function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && i < 3; i++) {
    if (typeof e === "object" && e !== null && (e as { code?: unknown }).code === "23505") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}
