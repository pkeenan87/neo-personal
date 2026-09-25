/**
 * No-database fallback for the dashboard queries (MOCK_MODE with zero
 * infrastructure, and the test suite). Same semantics as `verdictQueries` /
 * `listMembers` in @neo/db (docs/contracts.md, _specs/dashboard.md), over the
 * in-memory verdict rows (lib/server/memory-state.ts) written by `saveVerdict`
 * (lib/server/verdicts.ts) for chat and inbound verdicts alike.
 * Never used when DATABASE_URL is set.
 */
import { InvalidCursorError, type HouseholdMember, type VerdictListOptions, type VerdictRow, type VerdictSummary } from "@neo/db";
import { SUBJECT_TYPES, VERDICTS, type SubjectType, type VerdictLabel } from "@neo/verdict";
import { memoryListMembers as listMemoryMembers, memoryVerdicts, type MemoryVerdictRow } from "./memory-state";

export interface VerdictSummaryOpts {
  userId?: string;
  sinceDays: 7 | 30 | 90;
}

export const MAX_VERDICT_PAGE = 50;
export const DEFAULT_VERDICT_PAGE = 20;

/** Cursor = base64url(`<createdAt ISO>|<id>`), as in the @neo/db contract. */
export function encodeVerdictCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, "utf8").toString("base64url");
}

export function decodeVerdictCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const [iso, id, ...rest] = raw.split("|");
    if (!iso || !id || rest.length) return null;
    const createdAt = new Date(iso);
    return Number.isNaN(createdAt.getTime()) ? null : { createdAt, id };
  } catch {
    return null;
  }
}

function toRow(r: MemoryVerdictRow): VerdictRow {
  return {
    id: r.id,
    tenantId: r.tenantId,
    userId: r.userId,
    conversationId: r.conversationId ?? null,
    subjectType: r.verdict.subject_type,
    verdict: r.verdict.verdict,
    confidence: r.verdict.confidence,
    headline: r.verdict.headline,
    body: r.verdict,
    source: r.source,
    artifactId: r.artifactId,
    createdAt: r.createdAt,
  };
}

function newestFirst(a: VerdictRow, b: VerdictRow): number {
  const t = b.createdAt.getTime() - a.createdAt.getTime();
  return t !== 0 ? t : b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
}

function tenantRows(tenantId: string): VerdictRow[] {
  return memoryVerdicts()
    .filter((r) => r.tenantId === tenantId)
    .map(toRow)
    .sort(newestFirst);
}

export const memoryVerdictQueries = {
  async list(tenantId: string, opts: VerdictListOptions = {}): Promise<{ items: VerdictRow[]; nextCursor?: string }> {
    const limit = Math.min(MAX_VERDICT_PAGE, Math.max(1, opts.limit ?? DEFAULT_VERDICT_PAGE));
    const after = opts.cursor ? decodeVerdictCursor(opts.cursor) : null;
    if (opts.cursor && !after) throw new InvalidCursorError(); // same contract as @neo/db
    const rows = tenantRows(tenantId).filter(
      (r) =>
        (!opts.userId || r.userId === opts.userId) &&
        (!opts.label || r.verdict === opts.label) &&
        (!opts.subjectType || r.subjectType === opts.subjectType) &&
        (!opts.source || r.source === opts.source) &&
        (!after ||
          r.createdAt.getTime() < after.createdAt.getTime() ||
          (r.createdAt.getTime() === after.createdAt.getTime() && r.id < after.id)),
    );
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return rows.length > limit && last ? { items, nextCursor: encodeVerdictCursor(last.createdAt, last.id) } : { items };
  },

  async get(tenantId: string, id: string): Promise<VerdictRow | undefined> {
    return tenantRows(tenantId).find((r) => r.id === id);
  },

  async summary(tenantId: string, opts: VerdictSummaryOpts, now = new Date()): Promise<VerdictSummary> {
    return summarize(
      tenantRows(tenantId).filter((r) => !opts.userId || r.userId === opts.userId),
      opts.sinceDays,
      now,
    );
  },

  async remove(tenantId: string, id: string): Promise<boolean> {
    const rows = memoryVerdicts();
    const idx = rows.findIndex((r) => r.tenantId === tenantId && r.id === id);
    if (idx < 0) return false;
    rows.splice(idx, 1);
    return true;
  },
};

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Aggregate rows into the contract's VerdictSummary (pure; also used by tests). */
export function summarize(rows: readonly VerdictRow[], sinceDays: 7 | 30 | 90, now = new Date()): VerdictSummary {
  const since = new Date(now.getTime() - sinceDays * 86_400_000);
  const inRange = rows.filter((r) => r.createdAt >= since && r.createdAt <= now);
  const byLabel = Object.fromEntries(VERDICTS.map((v) => [v, 0])) as Record<VerdictLabel, number>;
  const bySubjectType = Object.fromEntries(SUBJECT_TYPES.map((s) => [s, 0])) as Record<SubjectType, number>;
  const indicators = new Map<string, number>();
  const domains = new Map<string, number>();
  const perDay = new Map<string, VerdictSummary["perDay"][number]>();

  for (const r of inRange) {
    byLabel[r.verdict]++;
    bySubjectType[r.subjectType]++;
    const body = r.body as { indicators?: Array<{ category?: unknown }>; iocs?: { domains?: unknown[] } };
    for (const ind of body.indicators ?? []) {
      if (typeof ind.category === "string" && ind.category) indicators.set(ind.category, (indicators.get(ind.category) ?? 0) + 1);
    }
    if (r.verdict !== "likely_safe") {
      for (const d of new Set(body.iocs?.domains ?? [])) {
        if (typeof d === "string" && d) domains.set(d.toLowerCase(), (domains.get(d.toLowerCase()) ?? 0) + 1);
      }
    }
    const day = utcDay(r.createdAt);
    const bucket = perDay.get(day) ?? { day, malicious: 0, suspicious: 0, likely_safe: 0, insufficient_evidence: 0 };
    bucket[r.verdict]++;
    perDay.set(day, bucket);
  }

  const top = (m: Map<string, number>) =>
    [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8);

  return {
    total: inRange.length,
    byLabel,
    bySubjectType,
    topIndicators: top(indicators).map(([category, count]) => ({ category, count })),
    topDomains: top(domains).map(([domain, count]) => ({ domain, count })),
    perDay: [...perDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
  };
}

// ─── Household members (no-database fallback) ──────────────────────

export async function memoryListMembers(tenantId: string): Promise<HouseholdMember[]> {
  return listMemoryMembers(tenantId);
}
