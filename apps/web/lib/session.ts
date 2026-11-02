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
 *
 * The Bearer / bypass / scope rules live in ./server/session-core.ts (no Next imports) so the eve
 * agent shares them; this file supplies the Next-only part (the request headers and Auth.js `auth()`).
 */
import { hashPii, logger } from "@neo/core";
import type { Session } from "next-auth";
import { headers } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";
import { jsonError } from "./server/http";
import { resolveSessionCore, type CookieIdentity, type NeoSession, type Resolution, type TokenScope } from "./server/session-core";

// The types and the dev identity live in session-core.ts (no Next imports, shared with the eve agent).
export { DEV_SESSION_IDS, type MembershipRole, type NeoSession, type TokenScope } from "./server/session-core";

export interface SessionOptions {
  /** Scope a desktop token must hold (default `full`). Browser sessions always resolve. */
  scope?: TokenScope;
}

/** Auth.js `auth()` reads the request's cookies, so it can only run in Next's request scope. */
async function authJsIdentity(): Promise<CookieIdentity | null> {
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
  return { userId: s.userId, tenantId: s.tenantId, role: s.role, email, name: s.user?.name?.trim() || email.split("@")[0] || "there" };
}

async function resolveSession(scope: TokenScope): Promise<Resolution> {
  let authorization: string | null = null;
  try {
    authorization = (await headers()).get("authorization");
  } catch {
    // No request scope (e.g. a build-time render): no Bearer token.
  }
  return resolveSessionCore({ authorization, scope, cookie: authJsIdentity });
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
