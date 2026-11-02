/**
 * Ownership of eve agent sessions (_specs/v2-m1-elder.md section 7). Tenant-scoped: a session of
 * another household is simply not visible, so it reads as unknown.
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { eveSessions } from "./schema/index.js";
import { assertTenantId, tenantScoped } from "./tenant.js";

/** eve session ids are opaque (`wrun_…`); bound what we store and look up. */
const SESSION_ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/;

export function isEveSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_RE.test(value);
}

/** Record the creator of a session. The first record wins; a repeat (event replay) changes nothing. */
export async function recordEveSession(db: Db, input: { tenantId: string; userId: string; sessionId: string }): Promise<void> {
  assertTenantId(input.tenantId);
  if (!isEveSessionId(input.sessionId)) throw new Error("@neo/db: invalid eve session id");
  await tenantScoped(db, input.tenantId).transaction((t) =>
    t.tx
      .insert(eveSessions)
      .values({ tenantId: input.tenantId, userId: input.userId, sessionId: input.sessionId })
      .onConflictDoNothing({ target: eveSessions.sessionId }),
  );
}

/** The user who created this session in this household, or undefined (unknown, or another household's). */
export async function getEveSessionOwner(db: Db, tenantId: string, sessionId: string): Promise<string | undefined> {
  assertTenantId(tenantId);
  if (!isEveSessionId(sessionId)) return undefined;
  const row = await tenantScoped(db, tenantId).first(eveSessions, and(eq(eveSessions.sessionId, sessionId)));
  return row?.userId;
}
