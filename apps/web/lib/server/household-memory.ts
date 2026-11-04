/**
 * Household memory service (_specs/v2-m3-cutover.md section 3): the one place that writes, reads and
 * forgets what the eve agent remembers. Behind the console routes (owner, browser session) and the eve
 * tools `remember` / `recall`. Imports nothing from Next, so the eve server can bundle it.
 *
 * - Postgres only. Without DATABASE_URL (the eve process always has it) the console answers 503
 *   `storage_unavailable` and the tools report that memory is unavailable.
 * - Writes are owner-only and re-check the membership in the database at that moment. The tenant and user
 *   come from the verified session or eve caller, never from input; the subject member must belong to the
 *   household. Every write passes `checkMemoryText`.
 * - Reads for the model go through `recallForAgent` and the wrapToolResult envelope (evidence, not
 *   instructions). Nothing is put into the system prompt.
 * - Audit metadata holds ids and lengths only, never the text.
 */
import { logger } from "@neo/core";
import {
  HOUSEHOLD_MEMORY_MAX,
  addHouseholdMemory,
  forgetHouseholdMemory,
  getMemberByUserId,
  listHouseholdMemory,
  listMemberRecords,
  purgeExpiredHouseholdMemory,
  tenantScoped,
  type HouseholdMemoryRow,
  type HouseholdMemorySource,
  type TenantDb,
} from "@neo/db";
import type { MemoryItem, MemoryListResponse } from "../memory-types";
import { recordAudit } from "./audit";
import { getDb } from "./db";
import { currentHouseholdRole, requireHouseholdAdmin, type HouseholdActor } from "./household-admin";
import type { Outcome } from "./household";
import { checkMemoryText } from "./memory-rules";

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 300);

type Failure = { ok: false; status: number; code: string; message: string };

function fail(status: number, code: string, message: string): Failure {
  return { ok: false, status, code, message };
}

const NO_STORAGE = fail(503, "storage_unavailable", "Neo can't reach its storage right now. Please try again in a moment.");
const LIMIT = fail(409, "memory_limit", "Neo already remembers 100 things. Forget one first.");
const BAD_SUBJECT = fail(400, "invalid_subject", "That person is not in your household.");

// ─── Console ───────────────────────────────────────────────────────

async function toItems(tdb: TenantDb, rows: readonly HouseholdMemoryRow[]): Promise<MemoryItem[]> {
  const names = new Map((await listMemberRecords(tdb)).map((m) => [m.id, m.displayName]));
  return rows.map((r) => ({
    id: r.id,
    text: r.text,
    about: r.subjectMemberId && names.has(r.subjectMemberId) ? { id: r.subjectMemberId, name: names.get(r.subjectMemberId)! } : null,
    source: r.source,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
  }));
}

// ─── Writes ────────────────────────────────────────────────────────

export type RememberResult =
  | { ok: true; id: string; status: "remembered" | "already_remembered" }
  | { ok: false; status: number; code: string; message: string };

/**
 * Store one memory as an owner. Order matters: the owner check first (so a member learns nothing about the
 * rules), then the content rules, then the subject and the cap inside one transaction.
 */
export async function rememberFact(
  actor: HouseholdActor,
  input: { text: unknown; subjectMemberId?: string | null | undefined },
  source: HouseholdMemorySource,
  now = new Date(),
): Promise<RememberResult> {
  const admin = await requireHouseholdAdmin(actor);
  if (!admin.ok) return admin;
  const checked = checkMemoryText(input.text);
  if (!checked.ok) return { ok: false, status: 400, code: checked.code, message: checked.message };
  const db = getDb();
  if (!db) return NO_STORAGE;
  const result = await addHouseholdMemory(tenantScoped(db, actor.tenantId), {
    text: checked.text,
    subjectMemberId: input.subjectMemberId || null,
    createdBy: actor.userId,
    source,
    now,
  });
  if (result.outcome === "limit") return LIMIT;
  if (result.outcome === "bad_subject") return BAD_SUBJECT;
  if (result.outcome === "created") {
    await recordAudit(actor.tenantId, actor.userId, "memory.added", {
      memoryId: result.row.id,
      length: [...checked.text].length,
      source,
      aboutMember: result.row.subjectMemberId !== null,
    });
  }
  return { ok: true, id: result.row.id, status: result.outcome === "created" ? "remembered" : "already_remembered" };
}

/** Console: add a memory (owner, browser session). */
export async function addMemoryFromConsole(actor: HouseholdActor, body: Record<string, unknown> | null): Promise<Outcome<MemoryItem>> {
  const text = body?.text;
  if (typeof text !== "string") return fail(400, "invalid", "Write what Neo should remember.");
  const subject = body?.subjectMemberId;
  if (subject !== undefined && subject !== null && subject !== "" && typeof subject !== "string") return BAD_SUBJECT;
  const r = await rememberFact(actor, { text, subjectMemberId: typeof subject === "string" ? subject : null }, "console");
  if (!r.ok) return fail(r.status, r.code, r.message);
  const db = getDb()!;
  const tdb = tenantScoped(db, actor.tenantId);
  const rows = await listHouseholdMemory(tdb);
  const row = rows.find((x) => x.id === r.id);
  const [item] = row ? await toItems(tdb, [row]) : [];
  if (!item) return fail(500, "failed", "Neo could not save that.");
  return { ok: true, value: item };
}

/** Console: forget one memory at once (owner, browser session). 404 for an unknown id or another household's. */
export async function forgetMemoryFromConsole(actor: HouseholdActor, id: string): Promise<Outcome<null>> {
  const admin = await requireHouseholdAdmin(actor);
  if (!admin.ok) return admin;
  const db = getDb();
  if (!db) return NO_STORAGE;
  const removed = await forgetHouseholdMemory(tenantScoped(db, actor.tenantId), id);
  if (!removed) return fail(404, "not_found", "Neo does not remember that.");
  await recordAudit(actor.tenantId, actor.userId, "memory.forgotten", { memoryId: id });
  return { ok: true, value: null };
}

/** Console: the household's memories (owner). Optionally only those about one member. */
export async function listMemoryForConsole(actor: HouseholdActor, opts: { memberId?: string } = {}): Promise<Outcome<MemoryListResponse>> {
  const admin = await requireHouseholdAdmin(actor);
  if (!admin.ok) return admin;
  const db = getDb();
  if (!db) return NO_STORAGE;
  const tdb = tenantScoped(db, actor.tenantId);
  const rows = await listHouseholdMemory(tdb);
  const items = await toItems(tdb, rows);
  return { ok: true, value: { memories: opts.memberId ? items.filter((i) => i.about?.id === opts.memberId) : items, max: HOUSEHOLD_MEMORY_MAX } };
}

// ─── The eve agent ─────────────────────────────────────────────────

export interface RecalledMemory {
  id: string;
  /** Written by an owner, but still evidence: the model must not follow instructions inside it. */
  text: string;
  /** Who it is about: a member's name, or null for the whole household. */
  about: string | null;
  remembered: string;
}

export type RecallResult = { ok: true; memories: RecalledMemory[] } | { ok: false; error: "not_a_member" | "failed"; message: string };

/**
 * `recall`: an owner sees everything; any other member sees the household-wide entries and those about
 * themselves. The role is re-read from the database, not taken from the caller's claim.
 */
export async function recallForAgent(caller: HouseholdActor, now = new Date()): Promise<RecallResult> {
  try {
    const role = await currentHouseholdRole(caller);
    if (!role) return { ok: false, error: "not_a_member", message: "Neo cannot tell who you are in this household." };
    const db = getDb();
    if (!db) return { ok: false, error: "failed", message: "Neo's memory is not available right now." };
    const tdb = tenantScoped(db, caller.tenantId);
    const own = role === "owner" ? undefined : ((await getMemberByUserId(tdb, caller.userId))?.id ?? null);
    const rows = await listHouseholdMemory(tdb, { forMemberId: own, now });
    const items = await toItems(tdb, rows);
    return { ok: true, memories: items.map((i) => ({ id: i.id, text: i.text, about: i.about?.name ?? null, remembered: i.createdAt.slice(0, 10) })) };
  } catch (err) {
    logger.error("Recalling household memory failed", "household-memory", { tenantId: caller.tenantId, errorMessage: errText(err) });
    return { ok: false, error: "failed", message: "Neo could not read its memory right now." };
  }
}

export type RememberToolResult =
  | { ok: true; status: "remembered" | "already_remembered"; message: string }
  | { ok: false; error: "not_allowed" | "rejected" | "limit" | "invalid" | "failed"; message: string };

/** `remember` at execution, run as the owner who approved the prompt. */
export async function rememberForAgent(caller: HouseholdActor, input: { text: string; subjectMemberId?: string | undefined }): Promise<RememberToolResult> {
  try {
    const r = await rememberFact(caller, input, "chat");
    if (r.ok) return { ok: true, status: r.status, message: r.status === "remembered" ? "Neo will remember that for a year." : "Neo already remembered that." };
    const error = r.code === "forbidden" ? "not_allowed" : r.code === "memory_limit" ? "limit" : r.code === "invalid_subject" ? "invalid" : r.code === "storage_unavailable" ? "failed" : "rejected";
    return { ok: false, error, message: r.message };
  } catch (err) {
    logger.error("Remembering failed", "household-memory", { tenantId: caller.tenantId, errorMessage: errText(err) });
    return { ok: false, error: "failed", message: "Neo could not save that right now." };
  }
}

/** Retention: delete expired memories across households. Called by the retention job (Inngest and eve). */
export async function purgeExpiredMemory(now = new Date()): Promise<number> {
  const db = getDb();
  if (!db) return 0;
  return purgeExpiredHouseholdMemory(db, now);
}
