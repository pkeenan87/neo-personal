import type { AuthFn } from "eve/channels/auth";
import { eveChatEnabled } from "@/lib/env";
import { callerOwnsSession, OWNER_WAIT_MS } from "@/lib/server/eve-session-owner";
import { resolveRequestSession } from "@/lib/server/session-core";

/** The session id a request path names (`/eve/v1/session/:id`, `.../stream`, `.../cancel`, ...), if any. */
export function sessionIdInPath(url: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const m = /\/session\/([^/]+)/.exec(pathname);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return m[1]!;
  }
}

/**
 * Who is calling the eve channel. eve runs as its own server, outside Next's request scope, so
 * `getSession()` cannot run here; this resolves the same session in-process with the code
 * `getSession()` shares (lib/server/session-core.ts): a `neo_dt_` Bearer token (scope `full` only,
 * so a monitoring token cannot chat), DEV_AUTH_BYPASS (never on production/preview), or the
 * Auth.js session cookie read from the database. No self-call to the Next app, no origin to configure.
 *
 * Two more gates, because eve has no access list of its own:
 * - NEO_EVE_CHAT must be `true`; otherwise nobody is a caller (401) and `/eve/v1/*` is closed
 *   (`localDev()` later in the walk still admits a local dev server only).
 * - A request that names a session (continue, controls, stream) is allowed only for the household
 *   and user that created it (recorded by agent/channels/eve.ts). Unknown id: denied after a short
 *   wait for the record of a session that was just created.
 * Any failure is no caller (401); the next entry in the channel's auth walk decides.
 */
export function createAppSession(opts: { ownerWaitMs?: number } = {}): AuthFn<Request> {
  return async (request) => {
    if (!eveChatEnabled()) return null;
    try {
      const session = await resolveRequestSession(request.headers, "full");
      if (!session) return null;
      const sessionId = sessionIdInPath(request.url);
      if (sessionId !== null && !(await callerOwnsSession(session, sessionId, { waitMs: opts.ownerWaitMs ?? OWNER_WAIT_MS }))) return null;
      return {
        authenticator: "neo-session",
        principalId: session.userId,
        principalType: "user",
        attributes: { tenantId: session.tenantId, role: session.role },
      };
    } catch {
      return null;
    }
  };
}

export const appSession = createAppSession();
