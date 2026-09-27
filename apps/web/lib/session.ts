/**
 * Server-side session helpers. Every tenant-scoped route and server component
 * takes `tenantId` from here and never from the request (_specs/tenant-auth.md).
 *
 *  - Normal path: Auth.js `auth()` (database session) → `{ userId, tenantId, role }`.
 *  - Desktop tokens: `Authorization: Bearer neo_dt_…` → same shape (Omarchy plugin),
 *    plus the token's `scopes` (_specs/device-enrollment.md). A token resolves only
 *    if it holds the scope asked for (`full` unless a route says otherwise), so
 *    monitoring tokens reach no existing route or page. A Bearer token is checked
 *    before DEV_AUTH_BYPASS, so device clients can be developed against MOCK_MODE.
 *  - DEV_AUTH_BYPASS (only when not production/preview, see lib/env.ts): a fixed
 *    dev identity. With a database, the dev user and its household are created
 *    on first use; without one, a fixed in-memory dev tenant is used so
 *    MOCK_MODE runs with zero infrastructure.
 */
import { hashPii, logger } from "@neo/core";
import { createTenantForUser, isDesktopTokenFormat, users, type Db, type TokenScope } from "@neo/db";
import { eq } from "drizzle-orm";
import type { Session } from "next-auth";
import { headers } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";
import { resolveBearerDesktopToken } from "./server/desktop-tokens";
import { getDb } from "./server/db";
import { jsonError } from "./server/http";
import { devAuthBypassRefused, env } from "./env";

export type MembershipRole = "owner" | "member";
export type { TokenScope };

/** Browser (Auth.js or dev-bypass) sessions and `full` desktop tokens. */
const FULL_SCOPES: TokenScope[] = ["full"];

export interface NeoSession {
  userId: string;
  tenantId: string;
  role: MembershipRole;
  email: string;
  name: string;
  /** Present when the session came from a desktop personal access token. */
  desktopTokenId?: string;
  /** What this session may do: `["full"]` for browser sessions; a desktop token's own scopes. */
  scopes: TokenScope[];
  /** The device a monitoring token reports for. */
  deviceId?: string;
}

export interface SessionOptions {
  /** Scope a desktop token must hold (default `full`). Browser sessions always resolve. */
  scope?: TokenScope;
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
  const base = { role: "owner" as const, email: e.DEV_USER_EMAIL, name: e.DEV_USER_NAME, scopes: [...FULL_SCOPES] };
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

/** `undefined`: no Bearer desktop token on the request; otherwise the token string. */
async function bearerDesktopToken(): Promise<string | undefined> {
  let authz: string | null = null;
  try {
    authz = (await headers()).get("authorization");
  } catch {
    return undefined;
  }
  if (!authz?.toLowerCase().startsWith("bearer ")) return undefined;
  const token = authz.slice(7).trim();
  return isDesktopTokenFormat(token) ? token : undefined;
}

type Resolution = { session: NeoSession; failure?: undefined } | { session: null; failure: "unauthenticated" | "insufficient_scope" };

async function sessionFromDesktopToken(token: string, scope: TokenScope): Promise<Resolution> {
  try {
    const resolved = await resolveBearerDesktopToken(token);
    if (!resolved) return { session: null, failure: "unauthenticated" };
    if (!resolved.scopes.includes(scope)) return { session: null, failure: "insufficient_scope" };
    return {
      session: {
        userId: resolved.userId,
        tenantId: resolved.tenantId,
        role: resolved.role,
        email: "",
        name: "desktop",
        desktopTokenId: resolved.id,
        scopes: [...resolved.scopes],
        ...(resolved.deviceId ? { deviceId: resolved.deviceId } : {}),
      },
    };
  } catch (err) {
    logger.error("Desktop token lookup failed", "auth", {
      errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
    return { session: null, failure: "unauthenticated" };
  }
}

/**
 * The request's session, or why there is none. A Bearer desktop token decides on its
 * own (also under DEV_AUTH_BYPASS): valid with the scope, valid without it
 * (`insufficient_scope`), or unknown/revoked (`unauthenticated`).
 */
async function resolveSession(scope: TokenScope): Promise<Resolution> {
  const token = await bearerDesktopToken();
  if (token) return sessionFromDesktopToken(token, scope);

  const e = env();
  if (e.DEV_AUTH_BYPASS) return { session: await devSession() };
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
    return { session: null, failure: "unauthenticated" };
  }
  if (!s?.userId || !s.tenantId || !s.role) {
    if (s?.userId) logger.warn("Signed-in user has no household", "auth", { userIdHash: hashPii(s.userId) });
    return { session: null, failure: "unauthenticated" };
  }
  const email = s.user?.email ?? "";
  return {
    session: {
      userId: s.userId,
      tenantId: s.tenantId,
      role: s.role,
      email,
      name: s.user?.name?.trim() || email.split("@")[0] || "there",
      scopes: [...FULL_SCOPES],
    },
  };
}

/**
 * The session, or null. A desktop token resolves only if it holds `opts.scope`
 * (default `full`); browser sessions always resolve with `scopes: ["full"]`.
 */
export async function getSession(opts: SessionOptions = {}): Promise<NeoSession | null> {
  return (await resolveSession(opts.scope ?? "full")).session;
}

/**
 * For server components/pages: returns the session or redirects to the landing
 * page. `returnTo` (a same-origin path) brings the user back after sign-in.
 */
export async function requireSession(returnTo?: string): Promise<NeoSession> {
  const session = await getSession();
  if (!session) redirect(returnTo ? `/?signin=required&next=${encodeURIComponent(returnTo)}` : "/?signin=required");
  return session;
}

/** True for a cookie (Auth.js or dev-bypass) session, false for a desktop token. */
export function isBrowserSession(session: NeoSession): boolean {
  return !session.desktopTokenId;
}

type ApiSessionResult = { session: NeoSession; response?: undefined } | { session?: undefined; response: Response };

function insufficientScope(): Response {
  return jsonError(403, "This device's token cannot do that.", "insufficient_scope");
}

/**
 * For API routes: the session, or a JSON error response to return as is: 401 without a
 * session (or with an unknown/revoked token), 403 `insufficient_scope` for a valid desktop
 * token without `opts.scope` (default `full`), so a client does not sign in again.
 */
export async function requireApiSession(opts: SessionOptions = {}): Promise<ApiSessionResult> {
  const r = await resolveSession(opts.scope ?? "full");
  if (r.session) return { session: r.session };
  if (r.failure === "insufficient_scope") return { response: insufficientScope() };
  return { response: jsonError(401, "Sign in to continue.", "unauthenticated") };
}

/**
 * For API routes that manage credentials: a browser session only. A desktop
 * token must never mint or approve other tokens (403 `browser_session_required`;
 * a monitoring token gets 403 `insufficient_scope`).
 */
export async function requireBrowserApiSession(): Promise<ApiSessionResult> {
  const r = await requireApiSession();
  if (!r.session) return r;
  if (!isBrowserSession(r.session)) {
    return { response: jsonError(403, "Sign in from a browser to do this.", "browser_session_required") };
  }
  return r;
}
