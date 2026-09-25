/**
 * Inbound persistence for the app: the @neo/db `inbound` helpers when
 * DATABASE_URL is set, else the in-memory fallback (MOCK_MODE / tests).
 * Contract calls go through lib/server/phase1-stubs-inbound.ts, the single
 * place the integration pass swaps for the real package exports.
 */
import type { Db } from "@neo/db";
import { getDb } from "../db";
import {
  getInboundArtifactStore,
  inbound,
  listMembers,
  purgeOldInboundMessages,
  saveVerdict,
  type ArtifactStore,
  type InboundMessagePatch,
  type InboundMessageRow,
  type InboundStatus,
  type MemberRow,
  type VerdictSource,
} from "../phase1-stubs-inbound";
import { memoryInbound } from "./memory";
import { env } from "@/lib/env";
import type { Verdict } from "@neo/verdict";

export interface InboundRepo {
  ensureAddress(tenantId: string): Promise<{ id: string; localPart: string }>;
  rotateAddress(tenantId: string): Promise<{ id: string; localPart: string }>;
  findActiveByLocalPart(localPart: string): Promise<{ id: string; tenantId: string } | undefined>;
  recordMessage(input: {
    tenantId: string;
    addressId: string;
    providerMessageId: string;
    fromAddressHash: string;
    status: InboundStatus;
  }): Promise<{ id: string }>;
  updateMessage(id: string, tenantId: string, patch: InboundMessagePatch): Promise<void>;
  countRecent(addressId: string, windowMs: number): Promise<number>;
  listRecent(tenantId: string, limit: number): Promise<InboundMessageRow[]>;
  /** Not in the contract: implemented with listRecent (a message is looked up only while it is recent). */
  findMessage(id: string, tenantId: string): Promise<InboundMessageRow | undefined>;
  purgeOld(before: Date): Promise<number>;
  listMembers(tenantId: string): Promise<MemberRow[]>;
  saveVerdict(input: { tenantId: string; userId: string; artifactId?: string; source: VerdictSource; verdict: Verdict }): Promise<{ id: string }>;
  artifacts: ArtifactStore | null;
}

function fromDb(db: Db): InboundRepo {
  const repo: InboundRepo = {
    ensureAddress: (t) => inbound.ensureAddress(db, t),
    rotateAddress: (t) => inbound.rotateAddress(db, t),
    findActiveByLocalPart: (lp) => inbound.findActiveByLocalPart(db, lp),
    recordMessage: (input) => inbound.recordMessage(db, input),
    updateMessage: (id, t, patch) => inbound.updateMessage(db, id, t, patch),
    countRecent: (a, w) => inbound.countRecent(db, a, w),
    listRecent: (t, n) => inbound.listRecent(db, t, n),
    findMessage: async (id, t) => (await inbound.listRecent(db, t, 200)).find((m) => m.id === id),
    purgeOld: (before) => purgeOldInboundMessages(db, before),
    listMembers: (t) => listMembers(db, t),
    saveVerdict: (input) => saveVerdict(db, input),
    artifacts: getInboundArtifactStore(db, env().MOCK_MODE),
  };
  return repo;
}

const memoryRepo: InboundRepo = {
  ensureAddress: memoryInbound.ensureAddress,
  rotateAddress: memoryInbound.rotateAddress,
  findActiveByLocalPart: memoryInbound.findActiveByLocalPart,
  recordMessage: memoryInbound.recordMessage,
  updateMessage: memoryInbound.updateMessage,
  countRecent: memoryInbound.countRecent,
  listRecent: memoryInbound.listRecent,
  findMessage: async (id, t) => (await memoryInbound.listRecent(t, 10_000)).find((m) => m.id === id),
  purgeOld: memoryInbound.purgeOld,
  listMembers: memoryInbound.listMembers,
  saveVerdict: memoryInbound.saveVerdict,
  artifacts: memoryInbound.artifacts,
};

export function inboundRepo(db: Db | null = getDb()): InboundRepo {
  return db ? fromDb(db) : memoryRepo;
}

/** True for a Postgres unique violation (duplicate provider_message_id). */
export function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && i < 3; i++) {
    if (typeof e === "object" && e !== null && (e as { code?: unknown }).code === "23505") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}
