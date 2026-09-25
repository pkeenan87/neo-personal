/**
 * No-database fallback for forward-to-address (MOCK_MODE demos and tests),
 * per process, same semantics as the Postgres helpers: unique local parts and
 * provider message ids (duplicates throw a pg-style `23505` error), tenant
 * checks on every per-tenant call, artifact retention.
 */
import type { Verdict } from "@neo/verdict";
import { env } from "@/lib/env";
import { DEV_SESSION_IDS } from "@/lib/session";
import type {
  ArtifactMeta,
  ArtifactStore,
  InboundMessagePatch,
  InboundMessageRow,
  InboundStatus,
  MemberRow,
  VerdictSource,
} from "../phase1-stubs-inbound";
import { generateLocalPart } from "./local-part";

interface AddressRow {
  id: string;
  tenantId: string;
  localPart: string;
  active: boolean;
  createdAt: Date;
  rotatedAt: Date | null;
}

export interface MemoryInboundVerdict {
  id: string;
  tenantId: string;
  userId: string;
  artifactId?: string;
  source: VerdictSource;
  verdict: Verdict;
  createdAt: Date;
}

interface State {
  addresses: AddressRow[];
  messages: InboundMessageRow[];
  artifacts: Map<string, { meta: ArtifactMeta; bytes: Uint8Array }>;
  verdicts: MemoryInboundVerdict[];
  members: Map<string, MemberRow[]>;
}

const g = globalThis as typeof globalThis & { __neoMemoryInbound?: State };

function state(): State {
  g.__neoMemoryInbound ??= { addresses: [], messages: [], artifacts: new Map(), verdicts: [], members: new Map() };
  return g.__neoMemoryInbound;
}

export class UniqueViolationError extends Error {
  readonly code = "23505";
}

const RETENTION_DAYS_DEFAULT = 30;

function retentionDays(): number {
  const n = Number.parseInt(process.env.NEO_ARTIFACT_RETENTION_DAYS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : RETENTION_DAYS_DEFAULT;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Buffer.from(digest).toString("hex");
}

const artifacts: ArtifactStore = {
  async put(input) {
    const now = new Date();
    const meta: ArtifactMeta = {
      id: crypto.randomUUID(),
      tenantId: input.tenantId,
      userId: input.userId,
      kind: input.kind,
      ...(input.filename ? { filename: input.filename } : {}),
      mimeType: input.mimeType,
      sizeBytes: input.bytes.byteLength,
      sha256: await sha256Hex(input.bytes),
      encrypted: false,
      source: input.source,
      createdAt: now,
      expiresAt: new Date(now.getTime() + retentionDays() * 86_400_000),
    };
    state().artifacts.set(meta.id, { meta, bytes: input.bytes.slice() });
    return meta;
  },
  async get(id, tenantId) {
    const a = state().artifacts.get(id);
    return a && a.meta.tenantId === tenantId ? a.meta : undefined;
  },
  async read(id, tenantId) {
    const a = state().artifacts.get(id);
    return a && a.meta.tenantId === tenantId ? a.bytes.slice() : undefined;
  },
  async delete(id, tenantId) {
    const a = state().artifacts.get(id);
    if (a && a.meta.tenantId === tenantId) state().artifacts.delete(id);
  },
  async listExpired(limit) {
    const now = Date.now();
    return [...state().artifacts.values()]
      .map((a) => a.meta)
      .filter((m) => m.expiresAt !== null && m.expiresAt.getTime() <= now)
      .slice(0, limit);
  },
  async purge(id) {
    state().artifacts.delete(id);
  },
};

export const memoryInbound = {
  artifacts,

  async ensureAddress(tenantId: string): Promise<{ id: string; localPart: string }> {
    const existing = state().addresses.find((a) => a.tenantId === tenantId && a.active);
    if (existing) return { id: existing.id, localPart: existing.localPart };
    const row: AddressRow = {
      id: crypto.randomUUID(),
      tenantId,
      localPart: generateLocalPart(),
      active: true,
      createdAt: new Date(),
      rotatedAt: null,
    };
    state().addresses.push(row);
    return { id: row.id, localPart: row.localPart };
  },

  async rotateAddress(tenantId: string): Promise<{ id: string; localPart: string }> {
    for (const a of state().addresses) {
      if (a.tenantId === tenantId && a.active) {
        a.active = false;
        a.rotatedAt = new Date();
      }
    }
    return memoryInbound.ensureAddress(tenantId);
  },

  async findActiveByLocalPart(localPart: string): Promise<{ id: string; tenantId: string } | undefined> {
    const a = state().addresses.find((x) => x.localPart === localPart && x.active);
    return a ? { id: a.id, tenantId: a.tenantId } : undefined;
  },

  async recordMessage(input: {
    tenantId: string;
    addressId: string;
    providerMessageId: string;
    fromAddressHash: string;
    status: InboundStatus;
  }): Promise<{ id: string }> {
    if (state().messages.some((m) => m.providerMessageId === input.providerMessageId)) {
      throw new UniqueViolationError("duplicate provider_message_id");
    }
    const row: InboundMessageRow = {
      id: crypto.randomUUID(),
      ...input,
      forwarderUserId: null,
      artifactId: null,
      verdictId: null,
      error: null,
      receivedAt: new Date(),
      completedAt: null,
    };
    state().messages.push(row);
    return { id: row.id };
  },

  async updateMessage(id: string, tenantId: string, patch: InboundMessagePatch): Promise<void> {
    const row = state().messages.find((m) => m.id === id && m.tenantId === tenantId);
    if (row) Object.assign(row, patch);
  },

  async countRecent(addressId: string, windowMs: number): Promise<number> {
    const since = Date.now() - windowMs;
    return state().messages.filter((m) => m.addressId === addressId && m.receivedAt.getTime() >= since).length;
  },

  async listRecent(tenantId: string, limit: number): Promise<InboundMessageRow[]> {
    return state()
      .messages.filter((m) => m.tenantId === tenantId)
      .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
      .slice(0, limit)
      .map((m) => ({ ...m }));
  },

  async purgeOld(before: Date): Promise<number> {
    const s = state();
    const keep = s.messages.filter(
      (m) => !((m.status === "rejected" || m.status === "failed") && m.receivedAt.getTime() < before.getTime()),
    );
    const removed = s.messages.length - keep.length;
    s.messages = keep;
    return removed;
  },

  async saveVerdict(input: {
    tenantId: string;
    userId: string;
    artifactId?: string;
    source: VerdictSource;
    verdict: Verdict;
  }): Promise<{ id: string }> {
    const row: MemoryInboundVerdict = { id: crypto.randomUUID(), ...input, createdAt: new Date() };
    state().verdicts.push(row);
    return { id: row.id };
  },

  /** Members: those registered with `setMembers`, else the DEV_AUTH_BYPASS identity for the dev tenant. */
  async listMembers(tenantId: string): Promise<MemberRow[]> {
    const registered = state().members.get(tenantId);
    if (registered) return registered.map((m) => ({ ...m }));
    if (tenantId === DEV_SESSION_IDS.tenantId) {
      const e = env();
      return [{ userId: DEV_SESSION_IDS.userId, name: e.DEV_USER_NAME, email: e.DEV_USER_EMAIL, role: "owner" }];
    }
    return [];
  },
};

/** Test/demo helpers. */
export function setMemoryMembers(tenantId: string, members: MemberRow[]): void {
  state().members.set(tenantId, members);
}

export function memoryInboundState(): Readonly<State> {
  return state();
}

export function resetMemoryInbound(): void {
  g.__neoMemoryInbound = undefined;
}
