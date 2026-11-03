/**
 * Child requests (_specs/v2-m2-child.md section 8): a child's device asks for more time, a site or an
 * app; a parent decides from the console, the email link or the eve agent. Imports nothing from Next,
 * so the eve server can bundle it.
 *
 * - Postgres only. Without DATABASE_URL (the eve process always has it) the device and console routes
 *   answer 503 `storage_unavailable` and the bundle simply has no grants.
 * - The member always comes from the device (`DeviceSession`), the tenant from the verified session;
 *   neither is read from input. The child's `reason` is attacker-controlled text: it is stored cleaned,
 *   shown quoted, and never used to decide anything.
 * - One decision service, `decideChildRequest`, behind the link page, the console button and the eve
 *   tools: owner re-check against the database, tenant-scoped load, one atomic claim, then the effect.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { effectivePolicy, endOfLocalDay, logger } from "@neo/core";
import {
  activeChildGrants,
  decideChildRequestRow,
  devices,
  expireChildRequests,
  getChildRequest,
  getHouseholdTimeZone,
  getProtectionLayers,
  listChildRequests,
  listMemberRecords,
  markChildRequestExpired,
  recordIncidentAction,
  resolveAlert,
  revertChildRequestDecision,
  tenantScoped,
  updateMemberRules,
  type ChildRequestRow,
  type TenantDb,
} from "@neo/db";
import { MAX_POLICY_APP_REFS, MAX_POLICY_DOMAINS, PolicyRulesSchema, type AppRef } from "@neo/verdict";
import { inArray } from "drizzle-orm";
import {
  requestSummary,
  type ChildRequestItem,
  type ChildRequestKindName,
  type DeviceRequestView,
  type UnblockScope,
} from "../child-request-types";
import type { DeviceSession } from "./session-core";
import { deviceLabel, displayName } from "./alerts/templates";
import { recordAudit } from "./audit";
import { approvalDone, approvalEffect, denyDone, effectGrant, type Effect } from "./child-request-effects";
import { getDb } from "./db";
import { requireHouseholdAdmin, type HouseholdActor } from "./household-admin";
import { isUuid } from "./incident-data";
import { takeRateSlot } from "./rate-limit";

// ─── Shared shapes ─────────────────────────────────────────────────

export type Outcome<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; message: string; fields?: { path: string; message: string }[] };

export const fail = (status: number, code: string, message: string, fields?: { path: string; message: string }[]): { ok: false; status: number; code: string; message: string; fields?: { path: string; message: string }[] } => ({
  ok: false,
  status,
  code,
  message,
  ...(fields ? { fields } : {}),
});

const NO_STORAGE = fail(503, "storage_unavailable", "Neo can't reach its storage right now. Please try again in a moment.");

/** Email-link tokens last this long. */
export const DECISION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
export const REQUEST_LIST_MAX = 50;

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 300);

// ─── Tokens ────────────────────────────────────────────────────────

/** A new random 32-byte email-link token (URL-safe) and its SHA-256 hex, the only form that is stored. */
export function newDecisionToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashDecisionToken(token) };
}

export function hashDecisionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function tokenMatches(stored: string | null, presented: string): boolean {
  if (!stored) return false;
  const a = Buffer.from(stored, "utf8");
  const b = Buffer.from(hashDecisionToken(presented), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

// ─── Names and mapping ─────────────────────────────────────────────

interface Names {
  members: Map<string, string>;
  devices: Map<string, string>;
}

async function namesFor(tdb: TenantDb, rows: readonly ChildRequestRow[]): Promise<Names> {
  const members = new Map((await listMemberRecords(tdb)).map((m) => [m.id, m.displayName]));
  const ids = [...new Set(rows.map((r) => r.deviceId).filter((d): d is string => d !== null))];
  const dev = ids.length > 0 ? await tdb.select(devices, inArray(devices.id, ids)) : [];
  return { members, devices: new Map(dev.map((d) => [d.id, d.name])) };
}

export function toRequestItem(row: ChildRequestRow, names: Names, now = new Date()): ChildRequestItem {
  // A pending request past its expiry reads as expired until the sweep marks it.
  const status = row.status === "pending" && row.expiresAt && row.expiresAt.getTime() <= now.getTime() ? "expired" : row.status;
  return {
    id: row.id,
    memberId: row.memberId,
    memberName: displayName(names.members.get(row.memberId), null),
    deviceName: row.deviceId && names.devices.has(row.deviceId) ? deviceLabel(names.devices.get(row.deviceId)) : null,
    kind: row.kind,
    detail: row.detail,
    summary: requestSummary(row.kind, row.detail),
    reason: row.reason,
    status,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    grant: row.grant,
  };
}

export function toDeviceView(row: ChildRequestRow, now = new Date()): DeviceRequestView {
  const status = row.status === "pending" && row.expiresAt && row.expiresAt.getTime() <= now.getTime() ? "expired" : row.status;
  return {
    id: row.id,
    kind: row.kind,
    status,
    detail: row.detail,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    grant: row.grant,
  };
}

// ─── Device API ────────────────────────────────────────────────────

/** Reads of a device's own requests, per device and hour (the status poll). */
export const REQUEST_READ_LIMIT = { limit: 300, windowMs: 60 * 60 * 1000 } as const;

/** `GET /api/devices/requests/:id`: the device's own request; anything else (another device's, another member's, unknown) is 404. */
export async function getDeviceRequest(session: DeviceSession, id: string, now = new Date()): Promise<Outcome<DeviceRequestView>> {
  const slot = takeRateSlot("device-requests-read", session.deviceId, REQUEST_READ_LIMIT.limit, REQUEST_READ_LIMIT.windowMs);
  if (!slot.ok) return fail(429, "rate_limited", "Too many attempts. Please try again later.");
  const db = getDb();
  if (!db) return NO_STORAGE;
  const row = isUuid(id) ? await getChildRequest(tenantScoped(db, session.tenantId), id) : undefined;
  if (!row || row.deviceId !== session.deviceId || row.memberId !== session.memberId) return fail(404, "not_found", "Not found.");
  return { ok: true, value: toDeviceView(row, now) };
}

/** `GET /api/devices/requests?status=pending`: the device's own requests, newest first (pending only when asked). */
export async function listDeviceRequests(session: DeviceSession, status: "pending" | undefined, now = new Date()): Promise<Outcome<{ requests: DeviceRequestView[] }>> {
  const slot = takeRateSlot("device-requests-read", session.deviceId, REQUEST_READ_LIMIT.limit, REQUEST_READ_LIMIT.windowMs);
  if (!slot.ok) return fail(429, "rate_limited", "Too many attempts. Please try again later.");
  const db = getDb();
  if (!db) return NO_STORAGE;
  const rows = await listChildRequests(tenantScoped(db, session.tenantId), { ...(status ? { status } : {}), deviceId: session.deviceId, now, limit: 20 });
  return { ok: true, value: { requests: rows.map((r) => toDeviceView(r, now)) } };
}

// ─── Console ───────────────────────────────────────────────────────

/** The household's requests for an owner: pending first, then newest. `memberId` narrows to one child. */
export async function listHouseholdRequests(actor: HouseholdActor, opts: { memberId?: string; status?: ChildRequestRowStatus; limit?: number } = {}, now = new Date()): Promise<Outcome<{ requests: ChildRequestItem[] }>> {
  const admin = await requireHouseholdAdmin(actor);
  if (!admin.ok) return fail(403, "forbidden", admin.message);
  const db = getDb();
  if (!db) return NO_STORAGE;
  if (opts.memberId !== undefined && !isUuid(opts.memberId)) return { ok: true, value: { requests: [] } };
  const tdb = tenantScoped(db, actor.tenantId);
  const rows = await listChildRequests(tdb, {
    ...(opts.status ? { status: opts.status } : {}),
    ...(opts.memberId ? { memberId: opts.memberId } : {}),
    now,
    limit: Math.min(opts.limit ?? REQUEST_LIST_MAX, REQUEST_LIST_MAX),
  });
  const names = await namesFor(tdb, rows);
  return { ok: true, value: { requests: rows.map((r) => toRequestItem(r, names, now)) } };
}

type ChildRequestRowStatus = ChildRequestRow["status"];

// ─── The decision link page ────────────────────────────────────────

export type DecisionLinkState =
  | { state: "forbidden" }
  | { state: "not_found" }
  | { state: "decided"; request: ChildRequestItem }
  | { state: "expired"; request: ChildRequestItem }
  /** The token does not belong to this request. */
  | { state: "token_invalid" }
  /** More than 24 hours old; the request itself can still be answered from the console. */
  | { state: "token_expired"; request: ChildRequestItem }
  | { state: "ready"; request: ChildRequestItem };

/**
 * What the `/requests/[id]/decide` page shows. Read-only: nothing is decided or consumed here. The
 * token only identifies the request; the signed-in owner and the confirm form decide.
 */
export async function previewDecisionLink(actor: HouseholdActor, id: string, token: string | undefined, now = new Date()): Promise<DecisionLinkState> {
  const admin = await requireHouseholdAdmin(actor);
  if (!admin.ok) return { state: "forbidden" };
  const db = getDb();
  if (!db) throw new Error("storage unavailable");
  const tdb = tenantScoped(db, actor.tenantId);
  const row = isUuid(id) ? await getChildRequest(tdb, id) : undefined;
  if (!row) return { state: "not_found" };
  const names = await namesFor(tdb, [row]);
  const request = toRequestItem(row, names, now);
  if (row.status === "approved" || row.status === "denied") return { state: "decided", request };
  if (request.status === "expired") return { state: "expired", request };
  if (!token || !tokenMatches(row.decisionTokenHash, token)) return { state: "token_invalid" };
  if (!row.decisionTokenExpiresAt || row.decisionTokenExpiresAt.getTime() <= now.getTime()) return { state: "token_expired", request };
  return { state: "ready", request };
}

// ─── Decisions ─────────────────────────────────────────────────────

export interface DecideOptions {
  /** `more_time`: minutes to give (1 to 120). Absent: what was asked for. */
  minutes?: number | undefined;
  /** `unblock_site`: default `once` (one hour). */
  scope?: UnblockScope | undefined;
  /** The email-link token, when the decision comes from the link page. */
  token?: string | undefined;
  via: "link" | "console" | "agent";
  now?: Date;
}

export type DecideResult =
  | { ok: true; decision: "approve" | "deny"; request: ChildRequestItem; message: string }
  | {
      ok: false;
      status: number;
      error: "not_allowed" | "not_found" | "already_decided" | "expired" | "invalid" | "policy_limit" | "token_invalid" | "token_expired" | "failed" | "storage_unavailable";
      message: string;
    };

const refuse = (status: number, error: Extract<DecideResult, { ok: false }>["error"], message: string): DecideResult => ({ ok: false, status, error, message });

class PolicyLimitError extends Error {}

const sameApp = (a: unknown, b: unknown): boolean => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, val]) => [k, sortKeys(val)]));
  return v;
}

/** The list a permanent approval would extend: the member's own, else what the layers give today. */
async function baselineLists(tdb: TenantDb, memberId: string, now: Date): Promise<{ allow: string[]; approved: AppRef[] }> {
  const layers = await getProtectionLayers(tdb, { memberId });
  const eff = effectivePolicy({ ...layers, now } as Parameters<typeof effectivePolicy>[0]);
  return { allow: [...(eff.web?.allow ?? [])], approved: [...(eff.apps?.approved ?? [])] };
}

/** Throws PolicyLimitError when adding would pass the list limit. Pure check on the baseline. */
function checkLimit(effect: Effect, base: { allow: string[]; approved: AppRef[] }): void {
  if (effect.kind === "unblock_site" && effect.scope === "always" && !base.allow.includes(effect.domain) && base.allow.length >= MAX_POLICY_DOMAINS) throw new PolicyLimitError();
  if (effect.kind === "install_app" && !base.approved.some((a) => sameApp(a, effect.app)) && base.approved.length >= MAX_POLICY_APP_REFS) throw new PolicyLimitError();
}

/** Append the allowed domain or app to the member's own policy (a new member policy version), deduped. */
async function appendToMemberPolicy(tdb: TenantDb, memberId: string, effect: Effect, base: { allow: string[]; approved: AppRef[] }, userId: string): Promise<void> {
  await updateMemberRules(
    tdb,
    memberId,
    (current) => {
      const parsed = PolicyRulesSchema.safeParse(current ?? {});
      const own = parsed.success ? parsed.data : {};
      if (effect.kind === "unblock_site" && effect.scope === "always") {
        const list = own.web?.allow ?? base.allow;
        if (list.includes(effect.domain)) return null;
        if (list.length >= MAX_POLICY_DOMAINS) throw new PolicyLimitError();
        return PolicyRulesSchema.parse({ ...own, web: { ...own.web, allow: [...list, effect.domain] } });
      }
      if (effect.kind === "install_app") {
        const list = own.apps?.approved ?? base.approved;
        if (list.some((a) => sameApp(a, effect.app))) return null;
        if (list.length >= MAX_POLICY_APP_REFS) throw new PolicyLimitError();
        return PolicyRulesSchema.parse({ ...own, apps: { ...own.apps, approved: [...list, effect.app] } });
      }
      return null;
    },
    userId,
  );
}

/**
 * Approve or deny a request. The steps, in order, each refusing without changing anything:
 * the owner check (re-read from the database), the tenant-scoped load, pending and not expired, the
 * link token (when one is presented), the exact effect, the policy-limit check. Then one atomic claim
 * (`UPDATE ... WHERE status = 'pending'`), so a double submit or two parents cannot both win; the
 * permanent policy change follows and the claim is undone if it cannot be stored. Last come the alert
 * (resolved), the `incident_actions` row and the audit event.
 */
export async function decideChildRequest(actor: HouseholdActor, requestId: string, decision: "approve" | "deny", opts: DecideOptions): Promise<DecideResult> {
  const now = opts.now ?? new Date();
  let admin;
  try {
    admin = await requireHouseholdAdmin(actor);
  } catch (err) {
    logger.error("Child request admin check failed", "child-requests", { tenantId: actor.tenantId, errorMessage: errText(err) });
    return refuse(503, "storage_unavailable", "Neo can't check who you are right now. Nothing was changed.");
  }
  if (!admin.ok) return refuse(403, "not_allowed", admin.message);
  const db = getDb();
  if (!db) return refuse(503, "storage_unavailable", NO_STORAGE.message);
  if (!isUuid(requestId)) return refuse(404, "not_found", "That request was not found.");
  const tdb = tenantScoped(db, actor.tenantId);
  let claimed = false;
  try {
    const row = await getChildRequest(tdb, requestId);
    if (!row) return refuse(404, "not_found", "That request was not found.");
    if (row.status === "expired") return refuse(410, "expired", "This request has expired.");
    if (row.status !== "pending") return refuse(409, "already_decided", `This request was already ${row.status}.`);
    if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) {
      await closeExpired(tdb, db, actor, row, now);
      return refuse(410, "expired", "This request has expired. It only lasts until the end of the child's day.");
    }
    if (opts.token !== undefined) {
      if (!tokenMatches(row.decisionTokenHash, opts.token)) return refuse(403, "token_invalid", "This link is not valid for this request.");
      if (!row.decisionTokenExpiresAt || row.decisionTokenExpiresAt.getTime() <= now.getTime()) return refuse(410, "token_expired", "This link has expired. You can still answer from the member's page in Neo.");
    }

    const names = await namesFor(tdb, [row]);
    const who = { memberName: displayName(names.members.get(row.memberId), null), deviceName: row.deviceId && names.devices.has(row.deviceId) ? deviceLabel(names.devices.get(row.deviceId)) : null };
    if (opts.minutes !== undefined && (!Number.isFinite(opts.minutes) || opts.minutes < 1)) return refuse(400, "invalid", "minutes must be a number from 1 to 120.");

    let effect: Effect | undefined;
    let base: { allow: string[]; approved: AppRef[] } | undefined;
    if (decision === "approve") {
      const timeZone = (await getHouseholdTimeZone(db, actor.tenantId)) ?? null;
      effect = approvalEffect(row, { minutes: opts.minutes, scope: opts.scope }, now, endOfLocalDay(now, timeZone));
      if (!effect) return refuse(400, "invalid", "This request can't be approved as it was stored.");
      if ((effect.kind === "unblock_site" && effect.scope === "always") || effect.kind === "install_app") {
        base = await baselineLists(tdb, row.memberId, now);
        try {
          checkLimit(effect, base);
        } catch (err) {
          if (err instanceof PolicyLimitError) return refuse(409, "policy_limit", "This child's allow list is full. Remove an entry on their page first.");
          throw err;
        }
      }
    }

    const won = await decideChildRequestRow(tdb, requestId, { status: decision === "approve" ? "approved" : "denied", decidedBy: actor.userId, grant: effect ? effectGrant(effect) : null, now });
    if (!won) {
      const again = await getChildRequest(tdb, requestId);
      return again?.status === "expired" ? refuse(410, "expired", "This request has expired.") : refuse(409, "already_decided", `This request was already ${again?.status ?? "answered"}.`);
    }
    claimed = true;

    if (effect && base && ((effect.kind === "unblock_site" && effect.scope === "always") || effect.kind === "install_app")) {
      try {
        await appendToMemberPolicy(tdb, row.memberId, effect, base, actor.userId);
      } catch (err) {
        await revertChildRequestDecision(tdb, requestId, actor.userId).catch(() => false);
        claimed = false;
        if (err instanceof PolicyLimitError) return refuse(409, "policy_limit", "This child's allow list is full. Remove an entry on their page first.");
        throw err;
      }
    }

    await finishDecision(tdb, db, actor, won, decision, effect, opts.via, now);
    const message = effect ? approvalDone(effect, who) : denyDone(row, who);
    return { ok: true, decision, request: toRequestItem(won, names, now), message };
  } catch (err) {
    logger.error("Child request decision failed", "child-requests", { tenantId: actor.tenantId, errorMessage: errText(err) });
    if (claimed) await revertChildRequestDecision(tdb, requestId, actor.userId).catch(() => false);
    return refuse(500, "failed", "That didn't work, so nothing was confirmed. Check the request before trying again.");
  }
}

/** After the claim: close the alert, write the action row and the audit event. None of these fails the decision. */
async function finishDecision(tdb: TenantDb, db: NonNullable<ReturnType<typeof getDb>>, actor: HouseholdActor, row: ChildRequestRow, decision: "approve" | "deny", effect: Effect | undefined, via: DecideOptions["via"], now: Date): Promise<void> {
  void tdb;
  if (row.alertId) {
    await resolveAlert(db, actor.tenantId, row.alertId, "resolved", actor.userId, now).catch((err: unknown) => logger.error("Closing a request alert failed", "child-requests", { tenantId: actor.tenantId, errorMessage: errText(err) }));
    await recordIncidentAction(db, actor.tenantId, {
      alertId: row.alertId,
      kind: decision === "approve" ? "approve_request" : "deny_request",
      requestedBy: via === "agent" ? "agent" : "admin",
      approvedBy: actor.userId,
      status: "done",
      result: { requestId: row.id, kind: row.kind, via, ...(effect ? { grant: effectGrant(effect) } : {}) },
    }).catch((err: unknown) => logger.error("Incident action row failed", "child-requests", { tenantId: actor.tenantId, errorMessage: errText(err) }));
  }
  // No reason text (the child's words) in the audit log.
  await recordAudit(actor.tenantId, actor.userId, "child_request.decided", {
    requestId: row.id,
    memberId: row.memberId,
    kind: row.kind,
    decision: decision === "approve" ? "approved" : "denied",
    via,
    ...(effect?.kind === "more_time" ? { minutes: effect.minutes } : {}),
    ...(effect?.kind === "unblock_site" ? { scope: effect.scope } : {}),
  });
}

/** A pending request found past its expiry: mark it expired and close its alert. */
async function closeExpired(tdb: TenantDb, db: NonNullable<ReturnType<typeof getDb>>, actor: HouseholdActor, row: ChildRequestRow, now: Date): Promise<void> {
  const expired = await markChildRequestExpired(tdb, row.id, now);
  if (expired?.alertId) await resolveAlert(db, actor.tenantId, expired.alertId, "resolved", actor.userId, now).catch(() => undefined);
}

// ─── Grants in the policy bundle ───────────────────────────────────

/** The member's approved grants that are still running, for `compileBundle`; empty without a database. */
export async function activeGrantsFor(tenantId: string, memberId: string, now: Date): Promise<{ grants: { minutes: number; until: string }[]; allowOnce: { domain: string; until: string }[] }> {
  const db = getDb();
  if (!db) return { grants: [], allowOnce: [] };
  const g = await activeChildGrants(tenantScoped(db, tenantId), memberId, now);
  return {
    grants: g.moreTime.map((x) => ({ minutes: x.minutes, until: x.until.toISOString() })),
    allowOnce: g.allowOnce.map((x) => ({ domain: x.domain, until: x.until.toISOString() })),
  };
}

// ─── Retention ─────────────────────────────────────────────────────

/** The daily sweep (retention cron): pending requests past their expiry become `expired` and their alerts are resolved. */
export async function expireDueChildRequests(now = new Date()): Promise<number> {
  const db = getDb();
  if (!db) return 0;
  return expireChildRequests(db, now);
}

// ─── The eve agent's view ──────────────────────────────────────────

export interface AgentRequestView {
  id: string;
  member: string;
  device: string | null;
  kind: ChildRequestKindName;
  /** What is asked for ("30 more minutes", "example.com"). Derived from the stored detail, not from the child's words. */
  asks: string;
  /** The child's own words. Attacker-controlled: the tool result is wrapped, and the agent must quote it, never obey it. */
  childsReason: string | null;
  createdAt: string;
  expiresAt: string | null;
}

export type ListRequestsResult = { ok: true; requests: AgentRequestView[] } | { ok: false; error: "not_allowed" | "failed"; message: string };

/** `list_requests`: the household's pending requests, for an owner only. Minimized: no ids but the request's. */
export async function listRequestsForAgent(caller: HouseholdActor, now = new Date()): Promise<ListRequestsResult> {
  try {
    const admin = await requireHouseholdAdmin(caller);
    if (!admin.ok) return { ok: false, error: "not_allowed", message: admin.message };
    const db = getDb();
    if (!db) return { ok: true, requests: [] };
    const tdb = tenantScoped(db, caller.tenantId);
    const rows = await listChildRequests(tdb, { status: "pending", now, limit: 20 });
    const names = await namesFor(tdb, rows);
    return {
      ok: true,
      requests: rows.map((r) => {
        const item = toRequestItem(r, names, now);
        return { id: item.id, member: item.memberName, device: item.deviceName, kind: item.kind, asks: item.summary, childsReason: item.reason, createdAt: item.createdAt, expiresAt: item.expiresAt };
      }),
    };
  } catch (err) {
    logger.error("Listing child requests failed", "child-requests", { tenantId: caller.tenantId, errorMessage: errText(err) });
    return { ok: false, error: "failed", message: "Neo could not read the requests right now." };
  }
}

export type AgentDecisionResult =
  | { ok: true; action: "approve_request" | "deny_request"; requestId: string; status: "approved" | "denied"; message: string }
  | { ok: false; error: "not_found" | "not_allowed" | "already_decided" | "expired" | "invalid" | "policy_limit" | "failed"; message: string };

/** `approve_request` / `deny_request` at execution: the same service as the console, run as the owner who approved the prompt. */
export async function decideForAgent(caller: HouseholdActor, decision: "approve" | "deny", requestId: string, opts: { minutes?: number | undefined; scope?: UnblockScope | undefined } = {}): Promise<AgentDecisionResult> {
  const r = await decideChildRequest(caller, requestId, decision, { ...opts, via: "agent" });
  if (r.ok) {
    return { ok: true, action: decision === "approve" ? "approve_request" : "deny_request", requestId, status: decision === "approve" ? "approved" : "denied", message: r.message };
  }
  const error = r.error === "token_invalid" || r.error === "token_expired" ? "invalid" : r.error === "storage_unavailable" ? "failed" : r.error;
  return { ok: false, error, message: r.message };
}
