/**
 * TODO(integration): replace with @neo/db exports.
 *
 * Typed placeholders for the Phase 1 @neo/db interfaces the dashboard needs
 * (docs/contracts.md "Package contracts (Phase 1)"), which are being built on
 * another branch: `verdictQueries`, `listMembers`, `ArtifactStore`,
 * `inbound.listRecent`, plus a household-name lookup the contract does not
 * name yet. Signatures follow the contract; bodies are in-memory. The
 * integration pass swaps the imports in THIS file only (every caller goes
 * through lib/server/verdict-data.ts):
 *
 *   verdictQueries, listMembers, VerdictRow, VerdictSummary   → @neo/db
 *   ArtifactMeta, ArtifactStore, getArtifactStore()           → @neo/db types + apps/web artifact store (agent C)
 *   inbound.listRecent, InboundMessageRow                     → @neo/db
 *   getHouseholdName                                          → @neo/db (not in the contract yet: open question)
 */
import type { Db } from "@neo/db";
import type { SubjectType, VerdictLabel } from "@neo/verdict";
import { memoryListMembers, memoryVerdictQueries } from "./verdict-memory";

export type VerdictSource = "chat" | "inbound" | "api";

export interface VerdictRow {
  id: string;
  tenantId: string;
  userId: string;
  conversationId: string | null;
  subjectType: SubjectType;
  verdict: VerdictLabel;
  confidence: number;
  headline: string;
  /** The full @neo/verdict `Verdict`. */
  body: Record<string, unknown>;
  source: VerdictSource;
  artifactId: string | null;
  createdAt: Date;
}

export interface VerdictListOpts {
  userId?: string;
  label?: VerdictLabel;
  subjectType?: SubjectType;
  source?: VerdictSource;
  cursor?: string;
  /** ≤ 50 */
  limit?: number;
}

export interface VerdictSummaryOpts {
  userId?: string;
  sinceDays: 7 | 30 | 90;
}

export interface VerdictSummary {
  total: number;
  byLabel: Record<VerdictLabel, number>;
  bySubjectType: Record<SubjectType, number>;
  topIndicators: { category: string; count: number }[];
  topDomains: { domain: string; count: number }[];
  perDay: { day: string; malicious: number; suspicious: number; likely_safe: number; insufficient_evidence: number }[];
}

export interface HouseholdMember {
  userId: string;
  name: string | null;
  email: string | null;
  role: "owner" | "member";
}

/** TODO(integration): `verdictQueries` from @neo/db. */
export const verdictQueries = {
  list: (_db: Db, tenantId: string, opts: VerdictListOpts) => memoryVerdictQueries.list(tenantId, opts),
  get: (_db: Db, tenantId: string, id: string) => memoryVerdictQueries.get(tenantId, id),
  summary: (_db: Db, tenantId: string, opts: VerdictSummaryOpts) => memoryVerdictQueries.summary(tenantId, opts),
  remove: (_db: Db, tenantId: string, id: string) => memoryVerdictQueries.remove(tenantId, id),
};

/** TODO(integration): `listMembers` from @neo/db. */
export function listMembers(_db: Db, tenantId: string): Promise<HouseholdMember[]> {
  return memoryListMembers(tenantId);
}

/** TODO(integration): not in the Phase 1 contract; @neo/db should expose the tenant name (tenants has no tenant_id column, so tenantScoped() cannot read it). */
export async function getHouseholdName(_db: Db | null, _tenantId: string): Promise<string | null> {
  return null;
}

// ─── Artifacts (agent C / @neo/db) ─────────────────────────────────

export type ArtifactKind = "eml" | "image" | "text" | "inbound_eml";

export interface ArtifactMeta {
  id: string;
  tenantId: string;
  userId: string;
  kind: ArtifactKind;
  filename?: string | null;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  encrypted: boolean;
  source: "upload" | "inbound";
  createdAt: Date;
  expiresAt: Date | null;
}

/** The subset of the contract's ArtifactStore the dashboard uses. */
export interface ArtifactStore {
  get(id: string, tenantId: string): Promise<ArtifactMeta | undefined>;
  delete(id: string, tenantId: string): Promise<void>;
}

const g = globalThis as typeof globalThis & { __neoStubArtifacts?: Map<string, ArtifactMeta> };

function artifactMap(): Map<string, ArtifactMeta> {
  g.__neoStubArtifacts ??= new Map();
  return g.__neoStubArtifacts;
}

/** Test helper for the stub store. */
export function putStubArtifact(meta: ArtifactMeta): void {
  artifactMap().set(meta.id, meta);
}

export function resetStubArtifacts(): void {
  g.__neoStubArtifacts = new Map();
}

/** TODO(integration): the app's artifact store (agent C: createArtifactStore(db, { blob, masterKey }) or its memory fallback). */
export function getArtifactStore(): ArtifactStore {
  return {
    async get(id, tenantId) {
      const a = artifactMap().get(id);
      return a && a.tenantId === tenantId ? a : undefined;
    },
    async delete(id, tenantId) {
      const a = artifactMap().get(id);
      if (a && a.tenantId === tenantId) artifactMap().delete(id);
    },
  };
}

// ─── Inbound messages (agent D / @neo/db) ──────────────────────────

export type InboundStatus = "received" | "analyzing" | "done" | "rejected" | "over_cap" | "failed";

/** Assumed row shape (the contract names the type but not its fields). */
export interface InboundMessageRow {
  id: string;
  tenantId: string;
  status: InboundStatus;
  forwarderUserId: string | null;
  verdictId: string | null;
  artifactId: string | null;
  receivedAt: Date;
  completedAt: Date | null;
}

const gi = globalThis as typeof globalThis & { __neoStubInbound?: InboundMessageRow[] };

export function putStubInbound(row: InboundMessageRow): void {
  gi.__neoStubInbound ??= [];
  gi.__neoStubInbound.push(row);
}

export function resetStubInbound(): void {
  gi.__neoStubInbound = [];
}

/** TODO(integration): `inbound` from @neo/db. */
export const inbound = {
  async listRecent(_db: Db | null, tenantId: string, limit: number): Promise<InboundMessageRow[]> {
    return (gi.__neoStubInbound ?? [])
      .filter((r) => r.tenantId === tenantId)
      .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
      .slice(0, limit);
  },
};
