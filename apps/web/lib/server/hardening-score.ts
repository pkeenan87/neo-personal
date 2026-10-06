/**
 * Account-hardening score service (_specs/hardening-score.md). The subject is always the session
 * user; scoring is pure (@neo/core) over answers and Neo-derived evidence read from Postgres via
 * @neo/db, or memory-hardening.ts without a database. Any store failure is `storage_unavailable`:
 * a score is never served from a cache.
 */
import {
  CURRENT_ACCOUNT_HARDENING_VERSION,
  isAccountHardeningAnswerAllowed,
  isAccountHardeningItemId,
  logger,
  scoreAccountHardening,
  type AccountHardeningEvidence,
  type AccountHardeningItemId,
  type AccountHardeningScore,
  type AccountHardeningVersion,
} from "@neo/core";
import { accountHardening, type AccountHardeningAnswer, type Db } from "@neo/db";
import type { NeoSession } from "@/lib/session";
import { getDb } from "./db";
import { createMemoryHardeningStore } from "./memory-hardening";
import { householdMembers } from "./verdict-data";

export type { AccountHardeningScore };

export interface HardeningStore {
  getAnswers(tenantId: string, userId: string): Promise<AccountHardeningAnswer[]>;
  getEvidence(tenantId: string, userId: string, asOf: Date): Promise<Required<AccountHardeningEvidence>>;
  set(answer: Omit<AccountHardeningAnswer, "answeredAt">, now?: Date): Promise<AccountHardeningAnswer>;
  clear(tenantId: string, userId: string, itemId: AccountHardeningItemId): Promise<boolean>;
}

export type HardeningErrorCode = "forbidden" | "storage_unavailable" | "checklist_version_mismatch" | "invalid_request";
const STATUS: Record<HardeningErrorCode, number> = { forbidden: 403, storage_unavailable: 503, checklist_version_mismatch: 409, invalid_request: 400 };

export class HardeningScoreError extends Error {
  readonly status: number;
  constructor(readonly code: HardeningErrorCode, message: string) {
    super(message);
    this.status = STATUS[code];
  }
}

export function createDbHardeningStore(db: Db): HardeningStore {
  return {
    getAnswers: (tenantId, userId) => accountHardening.getAnswers(db, tenantId, userId),
    getEvidence: (tenantId, userId, asOf) => accountHardening.getEvidence(db, tenantId, userId, asOf),
    set: (answer, now) => accountHardening.set(db, answer, now),
    clear: (tenantId, userId, itemId) => accountHardening.clear(db, tenantId, userId, itemId),
  };
}

export function getHardeningStore(): HardeningStore {
  const db = getDb();
  return db ? createDbHardeningStore(db) : createMemoryHardeningStore();
}

function isForeignKeyViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    if ((e as { code?: unknown }).code === "23503") return true;
  }
  return false;
}

function unavailable(err: unknown, tenantId: string): HardeningScoreError {
  logger.error("Hardening score storage failed", "hardening-score", {
    tenantId,
    errorMessage: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
  });
  return new HardeningScoreError("storage_unavailable", "Neo can't reach its storage right now. Please try again in a moment.");
}

/** One member's score from `store`. Throws `storage_unavailable` on any read failure. */
export async function scoreMember(store: HardeningStore, tenantId: string, userId: string, asOf: Date): Promise<AccountHardeningScore> {
  try {
    const [answers, evidence] = await Promise.all([store.getAnswers(tenantId, userId), store.getEvidence(tenantId, userId, asOf)]);
    return scoreAccountHardening({ answers, evidence, asOf });
  } catch (err) {
    throw unavailable(err, tenantId);
  }
}

export function loadAccountHardeningScore(session: NeoSession, asOf: Date = new Date()): Promise<AccountHardeningScore> {
  return scoreMember(getHardeningStore(), session.tenantId, session.userId, asOf);
}

/** Owner only: each current member's percentage (or null for "not enough answers"), nothing else. */
export async function loadHouseholdHardeningPercents(session: NeoSession): Promise<Array<{ userId: string; scorePercent: number | null }>> {
  if (session.role !== "owner") throw new HardeningScoreError("forbidden", "Only the household owner can see members' scores.");
  const store = getHardeningStore();
  const asOf = new Date();
  let members;
  try {
    members = await householdMembers(session);
  } catch (err) {
    throw unavailable(err, session.tenantId);
  }
  return Promise.all(members.map(async m => ({
    userId: m.userId,
    scorePercent: (await scoreMember(store, session.tenantId, m.userId, asOf)).scorePercent,
  })));
}

export async function setAccountHardeningAnswer(
  session: NeoSession,
  input: { itemId: AccountHardeningItemId; checklistVersion: AccountHardeningVersion; value: boolean | "not_applicable" },
): Promise<AccountHardeningScore> {
  if (input.checklistVersion !== CURRENT_ACCOUNT_HARDENING_VERSION) {
    throw new HardeningScoreError("checklist_version_mismatch", "The checklist changed. Reload the page and answer again.");
  }
  if (!isAccountHardeningItemId(input.itemId) || !isAccountHardeningAnswerAllowed(input.itemId, input.value)) {
    throw new HardeningScoreError("invalid_request", "That answer is not valid for this item.");
  }
  const store = getHardeningStore();
  const now = new Date();
  try {
    await store.set({ tenantId: session.tenantId, userId: session.userId, itemId: input.itemId, value: input.value, checklistVersion: input.checklistVersion }, now);
  } catch (err) {
    // The answer's (tenant, user) foreign key to memberships: no membership row means not a member.
    if (isForeignKeyViolation(err)) throw new HardeningScoreError("forbidden", "Only household members can answer the checklist.");
    throw unavailable(err, session.tenantId);
  }
  return scoreMember(store, session.tenantId, session.userId, now);
}

export async function clearAccountHardeningAnswer(session: NeoSession, itemId: AccountHardeningItemId): Promise<AccountHardeningScore> {
  if (!isAccountHardeningItemId(itemId)) throw new HardeningScoreError("invalid_request", "Unknown checklist item.");
  const store = getHardeningStore();
  try {
    await store.clear(session.tenantId, session.userId, itemId);
  } catch (err) {
    throw unavailable(err, session.tenantId);
  }
  return scoreMember(store, session.tenantId, session.userId, new Date());
}
