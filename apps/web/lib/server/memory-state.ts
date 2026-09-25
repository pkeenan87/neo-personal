/**
 * The single no-database fallback for Phase 1 state (MOCK_MODE with zero
 * infrastructure, and the test suite): verdicts, household members, and
 * forward-to-address rows. Chat verdicts, inbound verdicts and the dashboard
 * all read and write here, so in MOCK_MODE a forwarded email's verdict shows
 * up on /dashboard and /verdicts/[id]. Artifacts are not here: they live in
 * the one artifact store (lib/server/artifacts.ts), which is also in memory
 * without a database. Never used when DATABASE_URL is set.
 */
import type { HouseholdMember, InboundMessageRow, VerdictSource } from "@neo/db";
import type { Verdict } from "@neo/verdict";
import { env } from "@/lib/env";
import { DEV_SESSION_IDS } from "@/lib/session";

export interface MemoryVerdictRow {
  id: string;
  tenantId: string;
  userId: string;
  conversationId: string | null;
  source: VerdictSource;
  artifactId: string | null;
  verdict: Verdict;
  createdAt: Date;
}

export interface MemoryInboundAddress {
  id: string;
  tenantId: string;
  localPart: string;
  active: boolean;
  createdAt: Date;
  rotatedAt: Date | null;
}

interface MemoryState {
  verdicts: MemoryVerdictRow[];
  members: Map<string, HouseholdMember[]>;
  inboundAddresses: MemoryInboundAddress[];
  inboundMessages: InboundMessageRow[];
}

const MAX_VERDICTS = 1000;

const g = globalThis as typeof globalThis & { __neoMemoryState?: MemoryState };

export function memoryState(): MemoryState {
  g.__neoMemoryState ??= { verdicts: [], members: new Map(), inboundAddresses: [], inboundMessages: [] };
  return g.__neoMemoryState;
}

/** Drop every Phase 1 in-memory row (tests). */
export function resetMemoryState(): void {
  g.__neoMemoryState = undefined;
}

// ─── Verdicts ──────────────────────────────────────────────────────

export function memoryVerdicts(): MemoryVerdictRow[] {
  return memoryState().verdicts;
}

/** Same input and `raw_ref` rule as @neo/db `saveVerdict`. */
export function saveMemoryVerdict(input: {
  tenantId: string;
  userId: string;
  conversationId?: string | null;
  artifactId?: string | null;
  source: VerdictSource;
  verdict: Verdict;
}): { id: string } {
  const verdict = input.artifactId && !input.verdict.raw_ref ? { ...input.verdict, raw_ref: input.artifactId } : input.verdict;
  const row: MemoryVerdictRow = {
    id: crypto.randomUUID(),
    tenantId: input.tenantId,
    userId: input.userId,
    conversationId: input.conversationId ?? null,
    source: input.source,
    artifactId: input.artifactId ?? null,
    verdict,
    createdAt: new Date(),
  };
  const rows = memoryVerdicts();
  rows.push(row);
  if (rows.length > MAX_VERDICTS) rows.splice(0, rows.length - MAX_VERDICTS);
  return { id: row.id };
}

// ─── Household members ─────────────────────────────────────────────

/** Test/demo helper: set the members of an in-memory household. */
export function setMemoryMembers(tenantId: string, members: HouseholdMember[]): void {
  memoryState().members.set(tenantId, members.map((m) => ({ ...m })));
}

/** Registered members, else the DEV_AUTH_BYPASS identity for the dev tenant, else none. */
export function memoryListMembers(tenantId: string): HouseholdMember[] {
  const registered = memoryState().members.get(tenantId);
  if (registered) return registered.map((m) => ({ ...m }));
  if (tenantId === DEV_SESSION_IDS.tenantId) {
    const e = env();
    return [{ userId: DEV_SESSION_IDS.userId, name: e.DEV_USER_NAME, email: e.DEV_USER_EMAIL, role: "owner" }];
  }
  return [];
}
