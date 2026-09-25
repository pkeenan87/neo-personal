/**
 * Dashboard data access with role enforcement (_specs/dashboard.md). Route
 * handlers and server pages both go through here, so the rules live in one
 * place:
 *   - every query is scoped to the session tenant;
 *   - members only ever see their own verdicts (a `userId` filter for anyone
 *     else is `forbidden`; another member's verdict id is `not_found`);
 *   - owners may filter by any current member (`not_found` for a user who is
 *     not in the household).
 *
 * Postgres via @neo/db when DATABASE_URL is set, else the shared in-memory
 * fallback (lib/server/memory-state.ts via verdict-memory.ts).
 */
import { hashPii, logger } from "@neo/core";
import { VerdictSchema, type Verdict } from "@neo/verdict";
import type {
  HouseholdResponse,
  SinceDays,
  VerdictDetailResponse,
  VerdictListItem,
  VerdictListResponse,
  VerdictSummaryResponse,
} from "@/lib/dashboard-types";
import type { NeoSession } from "@/lib/session";
import { recordAudit } from "./audit";
import { getConversationStore } from "./conversation-store";
import { getDb } from "./db";
import {
  getHouseholdName,
  inbound,
  listMembers,
  verdictQueries,
  type HouseholdMember,
  type InboundMessageRow,
  type VerdictListOptions as VerdictListOpts,
  type VerdictRow,
} from "@neo/db";
import { getArtifactStore } from "./artifacts";
import { memoryState } from "./memory-state";
import { memoryListMembers, memoryVerdictQueries } from "./verdict-memory";

export const VERDICT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AccessError = "forbidden" | "not_found";
export type Result<T> = { ok: true; value: T } | { ok: false; error: AccessError };

const db = () => getDb();

async function queryList(tenantId: string, opts: VerdictListOpts) {
  const d = db();
  return d ? verdictQueries.list(d, tenantId, opts) : memoryVerdictQueries.list(tenantId, opts);
}
async function queryGet(tenantId: string, id: string) {
  const d = db();
  return d ? verdictQueries.get(d, tenantId, id) : memoryVerdictQueries.get(tenantId, id);
}
async function querySummary(tenantId: string, opts: { userId?: string; sinceDays: SinceDays }) {
  const d = db();
  return d ? verdictQueries.summary(d, tenantId, opts) : memoryVerdictQueries.summary(tenantId, opts);
}
async function queryRemove(tenantId: string, id: string) {
  const d = db();
  return d ? verdictQueries.remove(d, tenantId, id) : memoryVerdictQueries.remove(tenantId, id);
}

/** Household members; the session user is always included (e.g. the in-memory dev tenant). */
export async function householdMembers(session: NeoSession): Promise<HouseholdMember[]> {
  const d = db();
  const members = d ? await listMembers(d, session.tenantId) : await memoryListMembers(session.tenantId);
  if (!members.some((m) => m.userId === session.userId)) {
    members.unshift({ userId: session.userId, name: session.name, email: session.email || null, role: session.role });
  }
  return members;
}

/**
 * Resolve the effective `userId` filter. Members are pinned to themselves;
 * owners may pass a member's id or nothing (whole household).
 */
export async function resolveUserFilter(session: NeoSession, requested: string | undefined): Promise<Result<string | undefined>> {
  if (session.role !== "owner") {
    if (requested && requested !== session.userId) return { ok: false, error: "forbidden" };
    return { ok: true, value: session.userId };
  }
  if (!requested || requested === session.userId) return { ok: true, value: requested };
  const members = await householdMembers(session);
  return members.some((m) => m.userId === requested) ? { ok: true, value: requested } : { ok: false, error: "not_found" };
}

export function toListItem(r: VerdictRow): VerdictListItem {
  return {
    id: r.id,
    subjectType: r.subjectType,
    verdict: r.verdict,
    confidence: r.confidence,
    headline: r.headline,
    source: r.source,
    createdAt: r.createdAt.toISOString(),
    userId: r.userId,
    conversationId: r.conversationId,
    artifactId: r.artifactId,
  };
}

export async function listVerdicts(
  session: NeoSession,
  opts: Omit<VerdictListOpts, "userId"> & { userId?: string },
): Promise<Result<VerdictListResponse>> {
  const user = await resolveUserFilter(session, opts.userId);
  if (!user.ok) return user;
  const { items, nextCursor } = await queryList(session.tenantId, { ...opts, userId: user.value });
  return { ok: true, value: { items: items.map(toListItem), nextCursor: nextCursor ?? null } };
}

export async function verdictSummary(
  session: NeoSession,
  opts: { userId?: string; sinceDays: SinceDays },
): Promise<Result<VerdictSummaryResponse>> {
  const user = await resolveUserFilter(session, opts.userId);
  if (!user.ok) return user;
  const s = await querySummary(session.tenantId, { sinceDays: opts.sinceDays, ...(user.value ? { userId: user.value } : {}) });
  return { ok: true, value: { sinceDays: opts.sinceDays, ...s } };
}

/** A verdict row visible to this session (tenant + role), or undefined. */
export async function getVisibleVerdict(session: NeoSession, id: string): Promise<VerdictRow | undefined> {
  if (!VERDICT_ID_RE.test(id)) return undefined;
  const row = await queryGet(session.tenantId, id);
  if (!row) return undefined;
  if (session.role !== "owner" && row.userId !== session.userId) return undefined;
  return row;
}

/** The stored Verdict body, validated (rows written by older code may not parse). */
export function verdictBody(row: VerdictRow): Verdict | null {
  const parsed = VerdictSchema.safeParse(row.body);
  return parsed.success ? parsed.data : null;
}

export async function verdictDetail(session: NeoSession, id: string, now = new Date()): Promise<VerdictDetailResponse | null> {
  const row = await getVisibleVerdict(session, id);
  if (!row) return null;
  const body = verdictBody(row);
  if (!body) return null;

  const [conversation, artifact, inboundRow, members] = await Promise.all([
    row.conversationId ? conversationTitle(session.tenantId, row.userId, row.conversationId) : null,
    row.artifactId ? safe(async () => getArtifactStore()?.get(row.artifactId!, session.tenantId), "artifact lookup") : undefined,
    row.source === "inbound" ? safe(() => inboundByVerdictId(session.tenantId, row.id), "inbound lookup") : undefined,
    householdMembers(session),
  ]);
  const nameOf = (userId: string | null | undefined) => {
    if (!userId) return null;
    const m = members.find((x) => x.userId === userId);
    return m?.name ?? m?.email?.split("@")[0] ?? null;
  };

  return {
    ...toListItem(row),
    body,
    conversation,
    artifact: artifact
      ? {
          id: artifact.id,
          kind: artifact.kind,
          filename: artifact.filename ?? null,
          mimeType: artifact.mimeType,
          sizeBytes: artifact.sizeBytes,
          expiresAt: artifact.expiresAt ? artifact.expiresAt.toISOString() : null,
          expired: artifact.expiresAt ? artifact.expiresAt.getTime() <= now.getTime() : false,
        }
      : null,
    inbound: inboundRow
      ? { status: inboundRow.status, receivedAt: inboundRow.receivedAt.toISOString(), forwardedBy: nameOf(inboundRow.forwarderUserId) }
      : null,
    memberName: nameOf(row.userId),
  };
}

async function inboundByVerdictId(tenantId: string, verdictId: string): Promise<InboundMessageRow | undefined> {
  const d = db();
  if (d) return inbound.findByVerdictId(d, tenantId, verdictId);
  return memoryState().inboundMessages.find((m) => m.tenantId === tenantId && m.verdictId === verdictId);
}

async function conversationTitle(tenantId: string, userId: string, id: string): Promise<{ id: string; title: string | null } | null> {
  const rows = await safe(() => getConversationStore().list(tenantId, userId), "conversation lookup");
  const c = rows?.find((r) => r.id === id);
  return c ? { id: c.id, title: c.title } : null;
}

async function safe<T>(fn: () => Promise<T>, what: string): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    logger.error(`Dashboard ${what} failed`, "dashboard", {
      errorMessage: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
    });
    return undefined;
  }
}

/**
 * Delete a verdict (owner, or the member it belongs to) and its linked
 * artifact, and write `verdict.deleted`. False when not visible.
 */
export async function deleteVerdict(session: NeoSession, id: string): Promise<boolean> {
  const row = await getVisibleVerdict(session, id);
  if (!row) return false;
  const removed = await queryRemove(session.tenantId, id);
  if (!removed) return false;
  let artifactDeleted = false;
  if (row.artifactId) {
    try {
      const store = getArtifactStore();
      if (store) {
        await store.delete(row.artifactId, session.tenantId);
        artifactDeleted = true;
      }
    } catch (err) {
      // The verdict is gone; the retention job purges the artifact at expiry.
      logger.error("Artifact delete failed", "dashboard", {
        tenantId: session.tenantId,
        errorMessage: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
      });
    }
  }
  await recordAudit(session.tenantId, session.userId, "verdict.deleted", {
    verdictId: id,
    ownerUserIdHash: hashPii(row.userId),
    artifactId: row.artifactId,
    artifactDeleted,
  });
  return true;
}

export async function household(session: NeoSession): Promise<HouseholdResponse> {
  const members = await householdMembers(session);
  const d = db();
  const name = (d ? await safe(() => getHouseholdName(d, session.tenantId), "household name") : undefined) ?? "Your household";
  return {
    tenantId: session.tenantId,
    name,
    role: session.role,
    members: members.map((m) => ({
      userId: m.userId,
      name: m.name,
      email: session.role === "owner" ? m.email : null,
      role: m.role,
    })),
  };
}

/** True once the household's forwarding address has received at least one message. */
export async function forwardingUsed(session: NeoSession): Promise<boolean> {
  const d = db();
  if (!d) return memoryState().inboundMessages.some((m) => m.tenantId === session.tenantId);
  const rows = await safe(() => inbound.listRecent(d, session.tenantId, 1), "inbound list");
  return (rows?.length ?? 0) > 0;
}
