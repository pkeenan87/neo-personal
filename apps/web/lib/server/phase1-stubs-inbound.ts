/**
 * Phase 1 stubs for forward-to-address (agent D). Everything the inbound
 * feature needs from @neo/db, @neo/core and @neo/tools is imported through
 * THIS file only, shaped exactly like docs/contracts.md "Package contracts
 * (Phase 1)". The implementations below are in-memory stand-ins good enough
 * for tests and MOCK_MODE.
 *
 * TODO(integration): replace with real exports. Swap each block for a
 * re-export, e.g.
 *   export { inbound, generateLocalPart, saveVerdict, listMembers, createArtifactStore,
 *            createVercelBlobClient, type ArtifactStore, type ArtifactMeta,
 *            type InboundStatus } from "@neo/db";
 *   export { runTriage, masterKeyFromEnv } from "@neo/core";
 *   export { analyzeEmail, EMAIL_ANALYSIS_GUIDANCE } from "@neo/tools";
 * and move the helpers that have no package export yet (`purgeOldInboundMessages`,
 * `getMessage`, `getInboundArtifactStore`) onto the real packages or into
 * lib/server/inbound/repo.ts. The no-database fallback (lib/server/inbound/memory.ts)
 * stays: MOCK_MODE without DATABASE_URL keeps using it.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { AgentUsage } from "@neo/core";
import type { Db } from "@neo/db";
import type { Verdict } from "@neo/verdict";
import { memoryInbound } from "./inbound/memory";

// ---------------------------------------------------------------- @neo/db ---

export type InboundStatus = "received" | "analyzing" | "done" | "rejected" | "over_cap" | "failed";

/** Row shape of `inbound_messages` (spec SQL). TODO(integration): take from @neo/db. */
export interface InboundMessageRow {
  id: string;
  tenantId: string;
  addressId: string;
  providerMessageId: string;
  fromAddressHash: string;
  forwarderUserId: string | null;
  artifactId: string | null;
  verdictId: string | null;
  status: InboundStatus;
  error: string | null;
  receivedAt: Date;
  completedAt: Date | null;
}

export type InboundMessagePatch = Partial<{
  status: InboundStatus;
  forwarderUserId: string | null;
  artifactId: string | null;
  verdictId: string | null;
  error: string | null;
  completedAt: Date | null;
}>;

export interface InboundApi {
  ensureAddress(db: Db, tenantId: string): Promise<{ id: string; localPart: string }>;
  rotateAddress(db: Db, tenantId: string): Promise<{ id: string; localPart: string }>;
  findActiveByLocalPart(db: Db, localPart: string): Promise<{ id: string; tenantId: string } | undefined>;
  recordMessage(
    db: Db,
    input: { tenantId: string; addressId: string; providerMessageId: string; fromAddressHash: string; status: InboundStatus },
  ): Promise<{ id: string }>;
  updateMessage(db: Db, id: string, tenantId: string, patch: InboundMessagePatch): Promise<void>;
  countRecent(db: Db, addressId: string, windowMs: number): Promise<number>;
  listRecent(db: Db, tenantId: string, limit: number): Promise<InboundMessageRow[]>;
}

/** TODO(integration): `export { inbound } from "@neo/db"`. */
export const inbound: InboundApi = {
  ensureAddress: async (_db, tenantId) => memoryInbound.ensureAddress(tenantId),
  rotateAddress: async (_db, tenantId) => memoryInbound.rotateAddress(tenantId),
  findActiveByLocalPart: async (_db, localPart) => memoryInbound.findActiveByLocalPart(localPart),
  recordMessage: async (_db, input) => memoryInbound.recordMessage(input),
  updateMessage: async (_db, id, tenantId, patch) => memoryInbound.updateMessage(id, tenantId, patch),
  countRecent: async (_db, addressId, windowMs) => memoryInbound.countRecent(addressId, windowMs),
  listRecent: async (_db, tenantId, limit) => memoryInbound.listRecent(tenantId, limit),
};

/**
 * Not in the contract: delete `rejected`/`failed` inbound rows older than `before`
 * across tenants (retention cron). Needs a security-definer function or the
 * owner role under RLS. TODO(integration): add to @neo/db `inbound` or drop.
 */
export async function purgeOldInboundMessages(_db: Db, before: Date): Promise<number> {
  return memoryInbound.purgeOld(before);
}

export { generateLocalPart, isInboundLocalPart } from "./inbound/local-part";

export type ArtifactKind = "eml" | "image" | "text" | "inbound_eml";
export interface ArtifactMeta {
  id: string;
  tenantId: string;
  userId: string;
  kind: ArtifactKind;
  filename?: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  encrypted: boolean;
  source: "upload" | "inbound";
  createdAt: Date;
  expiresAt: Date | null;
}
export interface ArtifactStore {
  put(input: {
    tenantId: string;
    userId: string;
    kind: ArtifactKind;
    filename?: string;
    mimeType: string;
    bytes: Uint8Array;
    source: "upload" | "inbound";
  }): Promise<ArtifactMeta>;
  get(id: string, tenantId: string): Promise<ArtifactMeta | undefined>;
  read(id: string, tenantId: string): Promise<Uint8Array | undefined>;
  delete(id: string, tenantId: string): Promise<void>;
  listExpired(limit: number): Promise<ArtifactMeta[]>;
  purge(id: string): Promise<void>;
}

/**
 * The artifact store for inbound mail, or null when storage is unavailable
 * (job → `failed` / `storage_unavailable`). Stub: in-memory whenever the
 * database is absent or MOCK_MODE is on; null otherwise.
 * TODO(integration): `createArtifactStore(db, { blob: createVercelBlobClient(), masterKey: masterKeyFromEnv() })`
 * when BLOB_READ_WRITE_TOKEN is set; share one factory with the intake feature (agent C).
 */
export function getInboundArtifactStore(db: Db | null, mock: boolean): ArtifactStore | null {
  if (!db || mock) return memoryInbound.artifacts;
  return null;
}

export type VerdictSource = "chat" | "inbound" | "api";

/** TODO(integration): `export { saveVerdict } from "@neo/db"`. */
export async function saveVerdict(
  _db: Db,
  input: { tenantId: string; userId: string; conversationId?: string; artifactId?: string; source: VerdictSource; verdict: Verdict },
): Promise<{ id: string }> {
  return memoryInbound.saveVerdict(input);
}

export interface MemberRow {
  userId: string;
  name: string | null;
  email: string | null;
  role: "owner" | "member";
}

/** TODO(integration): `export { listMembers } from "@neo/db"`. */
export async function listMembers(_db: Db, tenantId: string): Promise<MemberRow[]> {
  return memoryInbound.listMembers(tenantId);
}

// -------------------------------------------------------------- @neo/core ---

export interface TriageInput {
  evidence: unknown;
  evidenceKind: "email" | "sms";
  guidance: string;
  client?: Anthropic;
  model?: string;
  signal?: AbortSignal;
}
export interface TriageResult {
  verdict: Verdict;
  usage: AgentUsage;
  model: string;
}

const DANGER = /(_fail\b|_fail_|^lookalike_|^dangerous_)/;

/**
 * TODO(integration): `export { runTriage } from "@neo/core"`. Stub mirrors the
 * spec's MOCK_MODE behaviour: a deterministic verdict from `heuristics`.
 */
export async function runTriage(input: TriageInput): Promise<TriageResult> {
  const ev = (input.evidence ?? {}) as { heuristics?: unknown; urls?: unknown };
  const heuristics = Array.isArray(ev.heuristics) ? ev.heuristics.filter((h): h is string => typeof h === "string") : [];
  const bad = heuristics.filter((h) => DANGER.test(h));
  const urls = Array.isArray(ev.urls) ? ev.urls.filter((u): u is string => typeof u === "string").slice(0, 20) : [];
  const verdict: Verdict = {
    subject_type: input.evidenceKind,
    verdict: bad.some((h) => h.startsWith("lookalike_") || h.startsWith("dangerous_")) ? "malicious" : bad.length ? "suspicious" : "likely_safe",
    confidence: bad.length ? 0.8 : 0.6,
    headline: bad.length ? "This message shows signs of phishing." : "Nothing in this message looks dangerous.",
    indicators: bad.map((h) => ({ severity: "high" as const, category: h, evidence: h, explanation: "Flagged by the email analyzer." })),
    recommended_actions: bad.length
      ? [{ action: "Don't click links or reply.", urgency: "now" as const }]
      : [{ action: "No action needed.", urgency: "optional" as const }],
    iocs: { urls, domains: [], ips: [], hashes: [], phone_numbers: [] },
  };
  return { verdict, usage: { input_tokens: 1200, output_tokens: 300 }, model: input.model ?? "claude-sonnet-5" };
}

// ------------------------------------------------------------- @neo/tools ---

export type EmailInput = { raw: string | Uint8Array } | { pasted: string };
/** Opaque to this feature: passed straight to runTriage as evidence. */
export type EmailAnalysis = { heuristics: string[]; errors: string[]; urls: string[]; [k: string]: unknown };

/** TODO(integration): `export { EMAIL_ANALYSIS_GUIDANCE } from "@neo/tools"`. */
export const EMAIL_ANALYSIS_GUIDANCE = "Weigh sender authentication, lookalike domains, and link reputation.";

/**
 * TODO(integration): `export { analyzeEmail } from "@neo/tools"`. Stub: offline
 * header and link sniffing (no network), enough for the job tests.
 */
export async function analyzeEmail(
  input: EmailInput,
  _opts: { signal?: AbortSignal; maxUrls?: number } = {},
): Promise<EmailAnalysis> {
  const text =
    "raw" in input ? (typeof input.raw === "string" ? input.raw : new TextDecoder().decode(input.raw)) : input.pasted;
  const heuristics: string[] = [];
  if (/dmarc=fail/i.test(text)) heuristics.push("dmarc_fail");
  if (/spf=fail/i.test(text)) heuristics.push("spf_fail");
  const urls = [...new Set(text.match(/https?:\/\/[^\s"'<>)]+/g) ?? [])].slice(0, _opts.maxUrls ?? 6);
  if (urls.some((u) => /paypa1|g00gle|micros0ft|app1e/i.test(u))) heuristics.push("lookalike_domain");
  return { heuristics, errors: [], urls, mock: true };
}
