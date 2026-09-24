/**
 * Server-side session helpers. Every tenant-scoped route and server component
 * takes `tenantId` from here and never from the request (_specs/tenant-auth.md).
 *
 *  - Normal path: Auth.js `auth()` (database session) → `{ userId, tenantId, role }`.
 *  - DEV_AUTH_BYPASS (only when not production/preview, see lib/env.ts): a fixed
 *    dev identity. With a database, the dev user and its household are created
 *    on first use; without one, a fixed in-memory dev tenant is used so
 *    MOCK_MODE runs with zero infrastructure.
 */
import { hashPii, logger } from "@neo/core";
import { createTenantForUser, users, type Db } from "@neo/db";
import { eq } from "drizzle-orm";
import type { Session } from "next-auth";
import { redirect, unstable_rethrow } from "next/navigation";
import { devAuthBypassRefused, env } from "./env";
import { jsonError } from "./server/http";
import { getDb } from "./server/db";

export type MembershipRole = "owner" | "member";

export interface NeoSession {
  userId: string;
  tenantId: string;
  role: MembershipRole;
  email: string;
  name: string;
}

/** Identity used by DEV_AUTH_BYPASS when there is no database. */
export const DEV_SESSION_IDS = {
  userId: "00000000-0000-4000-8000-000000000001",
  tenantId: "00000000-0000-4000-8000-0000000000aa",
} as const;

const g = globalThis as typeof globalThis & {
  __neoDevIdentity?: { db: Db; email: string; ids: Promise<{ userId: string; tenantId: string }> };
  __neoBypassRefusedLogged?: boolean;
};

async function ensureDevIdentity(db: Db, email: string, name: string): Promise<{ userId: string; tenantId: string }> {
  await db.insert(users).values({ email, name }).onConflictDoNothing({ target: users.email });
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (!row) throw new Error("dev user could not be created");
  const { tenantId } = await createTenantForUser(db, { userId: row.id, name: "Dev household" });
  return { userId: row.id, tenantId };
}

async function devSession(): Promise<NeoSession> {
  const e = env();
  const base = { role: "owner" as const, email: e.DEV_USER_EMAIL, name: e.DEV_USER_NAME };
  const db = getDb();
  if (!db) return { ...DEV_SESSION_IDS, ...base };
  if (g.__neoDevIdentity?.db !== db || g.__neoDevIdentity.email !== e.DEV_USER_EMAIL) {
    const ids = ensureDevIdentity(db, e.DEV_USER_EMAIL, e.DEV_USER_NAME);
    g.__neoDevIdentity = { db, email: e.DEV_USER_EMAIL, ids };
    ids.catch(() => {
      if (g.__neoDevIdentity?.ids === ids) g.__neoDevIdentity = undefined;
    });
  }
  return { ...(await g.__neoDevIdentity.ids), ...base };
}

export async function getSession(): Promise<NeoSession | null> {
  const e = env();
  if (e.DEV_AUTH_BYPASS) return devSession();
  if (devAuthBypassRefused() && !g.__neoBypassRefusedLogged) {
    g.__neoBypassRefusedLogged = true;
    logger.error("DEV_AUTH_BYPASS is set on a production/preview deployment and is ignored", "auth");
  }

  let s: Session | null;
  try {
    const { auth } = await import("@/auth");
    s = await auth();
  } catch (err) {
    unstable_rethrow(err); // Next.js control flow (dynamic rendering bailout, redirects) must propagate
    logger.error("Session lookup failed", "auth", {
      errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
    return null;
  }
  if (!s?.userId || !s.tenantId || !s.role) {
    if (s?.userId) logger.warn("Signed-in user has no household", "auth", { userIdHash: hashPii(s.userId) });
    return null;
  }
  const email = s.user?.email ?? "";
  return {
    userId: s.userId,
    tenantId: s.tenantId,
    role: s.role,
    email,
    name: s.user?.name?.trim() || email.split("@")[0] || "there",
  };
}

/** For server components/pages: returns the session or redirects to the landing page. */
export async function requireSession(): Promise<NeoSession> {
  const session = await getSession();
  if (!session) redirect("/?signin=required");
  return session;
}

/** For API routes: the session, or a 401 JSON response to return as is. */
export async function requireApiSession(): Promise<{ session: NeoSession; response?: undefined } | { session?: undefined; response: Response }> {
  const session = await getSession();
  if (!session) return { response: jsonError(401, "Sign in to continue.", "unauthenticated") };
  return { session };
}
