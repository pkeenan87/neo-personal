import { and, asc, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import { VerdictSchema, type Verdict } from "@neo/verdict";
import type { Db } from "./client.js";
import {
  memberships,
  users,
  verdicts,
  VERDICT_LABELS,
  VERDICT_SUBJECT_TYPES,
  type MembershipRole,
  type VerdictLabel,
  type VerdictSource,
  type VerdictSubjectType,
} from "./schema/index.js";
import { tenantScoped } from "./tenant.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;

export type VerdictRow = {
  id: string;
  tenantId: string;
  userId: string;
  conversationId: string | null;
  artifactId: string | null;
  source: VerdictSource;
  subjectType: VerdictSubjectType;
  verdict: VerdictLabel;
  confidence: number;
  headline: string;
  /** The full stored `Verdict`. */
  body: Verdict;
  createdAt: Date;
};

export type SaveVerdictInput = {
  tenantId: string;
  userId: string;
  conversationId?: string | null;
  artifactId?: string | null;
  source: VerdictSource;
  verdict: Verdict;
};

/**
 * Validate (`VerdictSchema`) and insert a verdict row, tenant-scoped. When `artifactId` is
 * given and the verdict has no `raw_ref`, `raw_ref` is set to it. Throws on invalid input or
 * a database error; callers that must never fail (chat) catch and log.
 */
export async function saveVerdict(db: Db, input: SaveVerdictInput): Promise<{ id: string }> {
  const parsed = VerdictSchema.parse(input.verdict);
  const body: Verdict = input.artifactId && !parsed.raw_ref ? { ...parsed, raw_ref: input.artifactId } : parsed;
  const [row] = await tenantScoped(db, input.tenantId).insert(verdicts, {
    userId: input.userId,
    conversationId: input.conversationId ?? null,
    artifactId: input.artifactId ?? null,
    source: input.source,
    subjectType: body.subject_type,
    verdict: body.verdict,
    confidence: body.confidence,
    headline: body.headline,
    body: body as unknown as Record<string, unknown>,
  });
  if (!row) throw new Error("@neo/db: verdict insert returned no row");
  return { id: row.id };
}

// ─────────────────────────────────────────────────────────────
//  Queries (dashboard)
// ─────────────────────────────────────────────────────────────

export class InvalidCursorError extends Error {
  constructor() {
    super("invalid cursor");
    this.name = "InvalidCursorError";
  }
}

export type VerdictListOptions = {
  userId?: string;
  label?: VerdictLabel;
  subjectType?: VerdictSubjectType;
  source?: VerdictSource;
  /** Opaque `nextCursor` from the previous page. */
  cursor?: string;
  /** Default 20, max 50. */
  limit?: number;
};

export type VerdictSummary = {
  total: number;
  byLabel: Record<VerdictLabel, number>;
  bySubjectType: Record<VerdictSubjectType, number>;
  topIndicators: { category: string; count: number }[];
  topDomains: { domain: string; count: number }[];
  perDay: { day: string; malicious: number; suspicious: number; likely_safe: number; insufficient_evidence: number }[];
};

type Cursor = { ts: string; id: string };

/** Cursor = base64url(`<created_at with microseconds, UTC>|<id>`). */
export function encodeVerdictCursor(ts: string, id: string): string {
  return Buffer.from(`${ts}|${id}`, "utf8").toString("base64url");
}

export function decodeVerdictCursor(cursor: string): Cursor {
  const raw = Buffer.from(cursor, "base64url").toString("utf8");
  const sep = raw.lastIndexOf("|");
  const ts = raw.slice(0, sep);
  const id = raw.slice(sep + 1);
  if (sep < 0 || !UUID_RE.test(id) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(ts) || Number.isNaN(Date.parse(ts))) {
    throw new InvalidCursorError();
  }
  return { ts, id };
}

// Microsecond-precision UTC timestamp: JS Dates stop at milliseconds, which would make the
// keyset skip rows created within the same millisecond.
const cursorTs = sql<string>`to_char(${verdicts.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

function toRow(r: typeof verdicts.$inferSelect): VerdictRow {
  return {
    id: r.id,
    tenantId: r.tenantId,
    userId: r.userId,
    conversationId: r.conversationId,
    artifactId: r.artifactId,
    source: r.source,
    subjectType: r.subjectType,
    verdict: r.verdict,
    confidence: r.confidence,
    headline: r.headline,
    body: r.body as unknown as Verdict,
    createdAt: r.createdAt,
  };
}

async function list(
  db: Db,
  tenantId: string,
  opts: VerdictListOptions = {},
): Promise<{ items: VerdictRow[]; nextCursor?: string }> {
  const limit = Math.max(1, Math.min(Math.floor(opts.limit ?? 20) || 20, 50));
  const conds: SQL[] = [eq(verdicts.tenantId, tenantId)];
  if (opts.userId !== undefined) conds.push(eq(verdicts.userId, opts.userId));
  if (opts.label !== undefined) conds.push(eq(verdicts.verdict, opts.label));
  if (opts.subjectType !== undefined) conds.push(eq(verdicts.subjectType, opts.subjectType));
  if (opts.source !== undefined) conds.push(eq(verdicts.source, opts.source));
  if (opts.cursor) {
    const c = decodeVerdictCursor(opts.cursor);
    conds.push(sql`(${verdicts.createdAt}, ${verdicts.id}) < (${c.ts}::timestamptz, ${c.id}::uuid)`);
  }

  const rows = await tenantScoped(db, tenantId).transaction((t) =>
    t.tx
      .select({ row: verdicts, cursorTs })
      .from(verdicts)
      .where(and(...conds))
      .orderBy(desc(verdicts.createdAt), desc(verdicts.id))
      .limit(limit + 1),
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => toRow(r.row)),
    ...(rows.length > limit && last ? { nextCursor: encodeVerdictCursor(last.cursorTs, last.row.id) } : {}),
  };
}

async function get(db: Db, tenantId: string, id: string): Promise<VerdictRow | undefined> {
  if (!UUID_RE.test(id)) return undefined;
  const r = await tenantScoped(db, tenantId).first(verdicts, eq(verdicts.id, id));
  return r ? toRow(r) : undefined;
}

async function remove(db: Db, tenantId: string, id: string): Promise<boolean> {
  if (!UUID_RE.test(id)) return false;
  const rows = await tenantScoped(db, tenantId).delete(verdicts, eq(verdicts.id, id));
  return rows.length > 0;
}

function zeroCounts<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
}

type Rows<T> = { rows: T[] };

async function summary(
  db: Db,
  tenantId: string,
  opts: { userId?: string; sinceDays: 7 | 30 | 90; now?: Date },
): Promise<VerdictSummary> {
  const sinceDays = [7, 30, 90].includes(opts.sinceDays) ? opts.sinceDays : 30;
  const now = opts.now ?? new Date();
  // Whole UTC days: today plus the previous sinceDays - 1 days.
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const since = new Date(todayStart - (sinceDays - 1) * DAY_MS);
  const until = new Date(todayStart + DAY_MS);

  const conds: SQL[] = [eq(verdicts.tenantId, tenantId), gte(verdicts.createdAt, since), lt(verdicts.createdAt, until)];
  if (opts.userId !== undefined) conds.push(eq(verdicts.userId, opts.userId));
  const where = and(...conds) as SQL;
  const TOP = 8;

  return tenantScoped(db, tenantId).transaction(async (t) => {
    const counts = await t.tx
      .select({ verdict: verdicts.verdict, subjectType: verdicts.subjectType, n: sql<number>`count(*)::int` })
      .from(verdicts)
      .where(where)
      .groupBy(verdicts.verdict, verdicts.subjectType);

    const indicators = (await t.tx.execute(sql`
      select ind->>'category' as category, count(distinct v.id)::int as count
      from ${verdicts} v
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(v.body->'indicators') = 'array' then v.body->'indicators' else '[]'::jsonb end
      ) ind
      where v.tenant_id = ${tenantId}
        and v.created_at >= ${since.toISOString()}::timestamptz
        and v.created_at < ${until.toISOString()}::timestamptz
        ${opts.userId !== undefined ? sql`and v.user_id = ${opts.userId}` : sql``}
        and coalesce(ind->>'category', '') <> ''
      group by 1
      order by 2 desc, 1 asc
      limit ${TOP}
    `)) as unknown as Rows<{ category: string; count: number }>;

    const domains = (await t.tx.execute(sql`
      select lower(d) as domain, count(distinct v.id)::int as count
      from ${verdicts} v
      cross join lateral jsonb_array_elements_text(
        case when jsonb_typeof(v.body->'iocs'->'domains') = 'array' then v.body->'iocs'->'domains' else '[]'::jsonb end
      ) d
      where v.tenant_id = ${tenantId}
        and v.created_at >= ${since.toISOString()}::timestamptz
        and v.created_at < ${until.toISOString()}::timestamptz
        and v.verdict <> 'likely_safe'
        ${opts.userId !== undefined ? sql`and v.user_id = ${opts.userId}` : sql``}
        and btrim(d) <> ''
      group by 1
      order by 2 desc, 1 asc
      limit ${TOP}
    `)) as unknown as Rows<{ domain: string; count: number }>;

    const days = await t.tx
      .select({
        day: sql<string>`to_char(date_trunc('day', ${verdicts.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`,
        verdict: verdicts.verdict,
        n: sql<number>`count(*)::int`,
      })
      .from(verdicts)
      .where(where)
      .groupBy(sql`1`, verdicts.verdict);

    const byLabel = zeroCounts(VERDICT_LABELS);
    const bySubjectType = zeroCounts(VERDICT_SUBJECT_TYPES);
    let total = 0;
    for (const c of counts) {
      const n = Number(c.n);
      total += n;
      if (c.verdict in byLabel) byLabel[c.verdict] += n;
      if (c.subjectType in bySubjectType) bySubjectType[c.subjectType] += n;
    }

    const perDay: VerdictSummary["perDay"] = [];
    const index = new Map<string, VerdictSummary["perDay"][number]>();
    for (let i = 0; i < sinceDays; i++) {
      const day = new Date(since.getTime() + i * DAY_MS).toISOString().slice(0, 10);
      const entry = { day, malicious: 0, suspicious: 0, likely_safe: 0, insufficient_evidence: 0 };
      perDay.push(entry);
      index.set(day, entry);
    }
    for (const d of days) {
      const entry = index.get(d.day);
      if (entry && d.verdict in byLabel) entry[d.verdict] += Number(d.n);
    }

    return {
      total,
      byLabel,
      bySubjectType,
      topIndicators: indicators.rows.map((r) => ({ category: r.category, count: Number(r.count) })),
      topDomains: domains.rows.map((r) => ({ domain: r.domain, count: Number(r.count) })),
      perDay,
    };
  });
}

/** Dashboard and history queries over `verdicts` (see _specs/dashboard.md). All tenant-scoped. */
export const verdictQueries = { list, get, summary, remove };

// ─────────────────────────────────────────────────────────────
//  Household members
// ─────────────────────────────────────────────────────────────

export type HouseholdMember = { userId: string; name: string | null; email: string | null; role: MembershipRole };

/** Members of a household, owners first, then by join date. */
export async function listMembers(db: Db, tenantId: string): Promise<HouseholdMember[]> {
  return tenantScoped(db, tenantId).transaction((t) =>
    t.tx
      .select({ userId: memberships.userId, name: users.name, email: users.email, role: memberships.role })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.tenantId, tenantId))
      .orderBy(sql`case when ${memberships.role} = 'owner' then 0 else 1 end`, asc(memberships.createdAt)),
  );
}
