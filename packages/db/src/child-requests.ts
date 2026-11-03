/**
 * Child requests (_specs/v2-m2-child.md section 8): what a child asks for from a device, and what a
 * parent decided. Every query is tenant-scoped. The decision is one atomic UPDATE on `status =
 * 'pending'`, so two parents (or a double submit) cannot both win. The email-link token is stored
 * hashed (the hash and expiry live on the row and are cleared by the decision); this module never
 * sees the raw token.
 */
import { and, eq, gt, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { childRequests, type ChildRequestKind, type ChildRequestStatus } from "./schema/index.js";
import type { TenantDb, TenantQueries } from "./tenant.js";

export type ChildRequestRow = typeof childRequests.$inferSelect;

/** Pending requests one device may have open at once. */
export const CHILD_REQUEST_MAX_PENDING = 5;
/** Requests one device may make per UTC day. */
export const CHILD_REQUEST_MAX_PER_DAY = 20;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Key-sorted JSON, so two equal details compare equal whatever their key order. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export interface CreateChildRequestInput {
  memberId: string;
  deviceId: string;
  kind: ChildRequestKind;
  detail: Record<string, unknown>;
  reason: string | null;
  /** End of the child's day in the household zone. */
  expiresAt: Date | null;
  /** SHA-256 hex of the email-link token and when it stops working. */
  tokenHash: string;
  tokenExpiresAt: Date;
  /** `device`: the child asked (limits apply). `system`: the policy engine opened it (only the dedupe applies). */
  source?: "device" | "system";
  /** An id chosen by the caller (so the email can name it before the row exists). */
  id?: string;
  now?: Date;
}

export type CreateChildRequestResult =
  | { outcome: "created"; row: ChildRequestRow }
  | { outcome: "existing"; row: ChildRequestRow }
  | { outcome: "too_many_pending" }
  | { outcome: "daily_limit" };

function utcDayStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

const stillPending = (now: Date) => and(eq(childRequests.status, "pending"), or(isNull(childRequests.expiresAt), gt(childRequests.expiresAt, now)));

/**
 * Open a request. Serialized per device (advisory lock) so the dedupe, the two limits and the
 * insert cannot interleave. An identical pending request of the same device (kind and detail) is
 * returned instead of a second one. Expired-but-unswept requests do not count as pending.
 */
export async function createChildRequest(tdb: TenantDb, input: CreateChildRequestInput): Promise<CreateChildRequestResult> {
  if (!UUID_RE.test(input.memberId) || !UUID_RE.test(input.deviceId)) throw new Error("@neo/db: invalid id");
  const now = input.now ?? new Date();
  return tdb.transaction(async (t) => {
    await t.tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`neo:child-request:${tdb.tenantId}:${input.deviceId}`}, 0))`);
    const pending = await t.select(childRequests, and(eq(childRequests.deviceId, input.deviceId), stillPending(now)));
    const origin = input.source === "system" ? "engine" : "device";
    const wanted = stable(input.detail);
    const same = pending.find((r) => r.kind === input.kind && stable(r.detail) === wanted);
    if (same) return { outcome: "existing", row: same };
    if (input.source !== "system") {
      // Only what the child opened counts; an app the engine holds for approval is not the child asking too often.
      if (pending.filter((r) => r.origin === "device").length >= CHILD_REQUEST_MAX_PENDING) return { outcome: "too_many_pending" };
      const today = await t.count(childRequests, and(eq(childRequests.deviceId, input.deviceId), eq(childRequests.origin, "device"), gte(childRequests.createdAt, utcDayStart(now))));
      if (today >= CHILD_REQUEST_MAX_PER_DAY) return { outcome: "daily_limit" };
    }
    const [row] = await t.insert(childRequests, {
      ...(input.id ? { id: input.id } : {}),
      memberId: input.memberId,
      deviceId: input.deviceId,
      origin,
      kind: input.kind,
      detail: input.detail,
      reason: input.reason,
      expiresAt: input.expiresAt,
      decisionTokenHash: input.tokenHash,
      decisionTokenExpiresAt: input.tokenExpiresAt,
      createdAt: now,
      updatedAt: now,
    });
    if (!row) throw new Error("@neo/db: child request insert returned no row");
    return { outcome: "created", row };
  });
}

/** The request an alert belongs to (`alert_id`), if any. */
export async function getChildRequestByAlert(tdb: TenantDb, alertId: string): Promise<ChildRequestRow | undefined> {
  if (!UUID_RE.test(alertId)) return undefined;
  return tdb.first(childRequests, eq(childRequests.alertId, alertId));
}

export async function getChildRequest(tdb: TenantDb, id: string): Promise<ChildRequestRow | undefined> {
  if (!UUID_RE.test(id)) return undefined;
  return tdb.first(childRequests, eq(childRequests.id, id));
}

export interface ListChildRequestsOptions {
  status?: ChildRequestStatus;
  memberId?: string;
  deviceId?: string;
  /** Only requests created at or after this. */
  since?: Date;
  /** `pending` also drops requests past their `expires_at` that the sweep has not reached yet. */
  now?: Date;
  limit?: number;
}

/** Pending first (when no status is asked for), then newest first. */
export async function listChildRequests(tdb: TenantDb, opts: ListChildRequestsOptions = {}): Promise<ChildRequestRow[]> {
  const conds = [];
  if (opts.status === "pending") conds.push(stillPending(opts.now ?? new Date()));
  else if (opts.status) conds.push(eq(childRequests.status, opts.status));
  if (opts.memberId) conds.push(eq(childRequests.memberId, opts.memberId));
  if (opts.deviceId) conds.push(eq(childRequests.deviceId, opts.deviceId));
  if (opts.since) conds.push(gte(childRequests.createdAt, opts.since));
  return tdb.select(childRequests, conds.length ? and(...conds) : undefined, {
    orderBy: [sql`(${childRequests.status} = 'pending') desc`, sql`${childRequests.createdAt} desc`],
    limit: Math.min(Math.max(opts.limit ?? 50, 1), 200),
  });
}

/** Link the request to its alert. */
export async function setChildRequestAlert(tdb: TenantDb, id: string, alertId: string | null): Promise<void> {
  if (!UUID_RE.test(id)) return;
  await tdb.update(childRequests, { alertId, updatedAt: new Date() }, eq(childRequests.id, id));
}

export interface DecideChildRequestInput {
  status: "approved" | "denied";
  decidedBy: string;
  grant: Record<string, unknown> | null;
  now?: Date;
}

/**
 * Claim the decision: pending and not past its expiry becomes approved or denied, the grant is
 * stored and the email-link token is cleared, all in one statement. Undefined when someone else
 * decided first (or the request is gone or expired): the caller must then do nothing.
 */
export async function decideChildRequestRow(tdb: TenantDb, id: string, input: DecideChildRequestInput): Promise<ChildRequestRow | undefined> {
  if (!UUID_RE.test(id)) return undefined;
  const now = input.now ?? new Date();
  const [row] = await tdb.update(
    childRequests,
    { status: input.status, decidedBy: input.decidedBy, decidedAt: now, grant: input.grant, decisionTokenHash: null, decisionTokenExpiresAt: null, updatedAt: now },
    and(eq(childRequests.id, id), stillPending(now)),
  );
  return row;
}

/** Undo a claim whose follow-up change could not be stored, so the parent can try again. Only the claimant's own decision. */
export async function revertChildRequestDecision(tdb: TenantDb, id: string, decidedBy: string): Promise<boolean> {
  if (!UUID_RE.test(id)) return false;
  const rows = await tdb.update(
    childRequests,
    { status: "pending", decidedBy: null, decidedAt: null, grant: null, updatedAt: new Date() },
    and(eq(childRequests.id, id), inArray(childRequests.status, ["approved", "denied"]), eq(childRequests.decidedBy, decidedBy)),
  );
  return rows.length > 0;
}

/** Mark one pending request past its expiry as expired (the read-time path; the daily sweep does the rest). */
export async function markChildRequestExpired(tdb: TenantDb, id: string, now = new Date()): Promise<ChildRequestRow | undefined> {
  if (!UUID_RE.test(id)) return undefined;
  const [row] = await tdb.update(
    childRequests,
    { status: "expired", decisionTokenHash: null, decisionTokenExpiresAt: null, updatedAt: now },
    and(eq(childRequests.id, id), eq(childRequests.status, "pending"), lte(childRequests.expiresAt, now)),
  );
  return row;
}

export interface ActiveChildGrants {
  /** Approved `more_time`: extra minutes valid until `until`. */
  moreTime: { minutes: number; until: Date }[];
  /** Approved one-hour `unblock_site`: the domain is allowed until `until`. */
  allowOnce: { domain: string; until: Date }[];
}

/** The member's approved grants that have not run out at `now`, oldest first. */
export async function activeChildGrants(tdb: TenantDb, memberId: string, now: Date): Promise<ActiveChildGrants> {
  const out: ActiveChildGrants = { moreTime: [], allowOnce: [] };
  if (!UUID_RE.test(memberId)) return out;
  // No grant outlives the day it was given (more time) or an hour (a one-off unblock): a two-day look-back is enough.
  const rows = await tdb.select(
    childRequests,
    and(
      eq(childRequests.memberId, memberId),
      eq(childRequests.status, "approved"),
      inArray(childRequests.kind, ["more_time", "unblock_site"]),
      gte(childRequests.decidedAt, new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000)),
    ),
    { orderBy: [sql`${childRequests.decidedAt} asc`, sql`${childRequests.id} asc`] },
  );
  for (const r of rows) {
    const g = r.grant ?? {};
    const until = typeof g.until === "string" ? new Date(g.until) : null;
    if (!until || Number.isNaN(until.getTime()) || until.getTime() <= now.getTime()) continue;
    if (r.kind === "more_time" && typeof g.minutes === "number" && Number.isInteger(g.minutes) && g.minutes > 0) out.moreTime.push({ minutes: g.minutes, until });
    else if (r.kind === "unblock_site" && typeof g.domain === "string") out.allowOnce.push({ domain: g.domain, until });
  }
  return out;
}

/** Counts of the household's requests created in `[from, to)`, by kind and status (the weekly digest). */
export async function summarizeChildRequests(tdb: TenantQueries, from: Date, to: Date): Promise<{ kind: ChildRequestKind; status: ChildRequestStatus; count: number }[]> {
  const rows = await tdb.select(childRequests, and(gte(childRequests.createdAt, from), lt(childRequests.createdAt, to)), { limit: 5000 });
  const counts = new Map<string, { kind: ChildRequestKind; status: ChildRequestStatus; count: number }>();
  for (const r of rows) {
    const key = `${r.kind}:${r.status}`;
    const cur = counts.get(key);
    if (cur) cur.count++;
    else counts.set(key, { kind: r.kind, status: r.status, count: 1 });
  }
  return [...counts.values()];
}

/**
 * The daily sweep, across households (`expire_child_requests`, security definer): every pending
 * request past its `expires_at` becomes `expired` and its alert is resolved. Returns the count.
 */
export async function expireChildRequests(db: Db, now = new Date()): Promise<number> {
  const res = await db.execute(sql`select public.expire_child_requests(${now.toISOString()}::timestamptz) as n`);
  return Number((res as unknown as { rows: Array<{ n: number }> }).rows[0]?.n ?? 0);
}
