/**
 * Who owns each eve agent session. eve has no per-session access list: any signed-in caller that
 * learns a session id could continue it or read its stream. The channel therefore records the
 * creator of every session (agent/channels/eve.ts, `session.started`) and its route auth lets
 * only the same household and user back in (agent/lib/app-session.ts). Postgres when there is a
 * database (`eve_sessions`, tenant-scoped, so another household's row is invisible); an in-process
 * map otherwise (MOCK_MODE and dev, where eve and these lookups share a process). No Next imports.
 */
import { getEveSessionOwner, isEveSessionId, recordEveSession } from "@neo/db";
import { getDb } from "./db";

export interface SessionOwner {
  tenantId: string;
  userId: string;
}

const g = globalThis as typeof globalThis & { __neoEveSessionOwners?: Map<string, string> };
const memory = () => (g.__neoEveSessionOwners ??= new Map());
const key = (tenantId: string, sessionId: string) => `${tenantId}:${sessionId}`;

/** How long a request for a not-yet-recorded session waits for its record (the record lands just after create returns). */
export const OWNER_WAIT_MS = 3000;
const POLL_MS = 100;

export async function recordSessionOwner(owner: SessionOwner, sessionId: string): Promise<void> {
  if (!isEveSessionId(sessionId)) return;
  const db = getDb();
  if (db) return recordEveSession(db, { ...owner, sessionId });
  const m = memory();
  if (!m.has(key(owner.tenantId, sessionId))) m.set(key(owner.tenantId, sessionId), owner.userId);
}

async function lookup(owner: SessionOwner, sessionId: string): Promise<string | undefined> {
  const db = getDb();
  return db ? getEveSessionOwner(db, owner.tenantId, sessionId) : memory().get(key(owner.tenantId, sessionId));
}

/**
 * Whether `caller` created `sessionId` (same household and same user). An unknown id is waited
 * for up to `waitMs`, then denied; a session recorded for someone else is denied at once. Fails
 * closed on any error.
 */
export async function callerOwnsSession(caller: SessionOwner, sessionId: string, opts: { waitMs?: number } = {}): Promise<boolean> {
  if (!isEveSessionId(sessionId)) return false;
  const deadline = Date.now() + (opts.waitMs ?? OWNER_WAIT_MS);
  try {
    for (;;) {
      const owner = await lookup(caller, sessionId);
      if (owner !== undefined) return owner === caller.userId;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  } catch {
    return false;
  }
}
