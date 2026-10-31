import type { AuthFn } from "eve/channels/auth";

/**
 * eve runs as its own server (next.config.ts rewrites /eve/v1/* to it), outside Next's request scope, so
 * getSession() cannot run here. Ask the Next app to run it: forward the caller's cookie / Bearer token to
 * /api/eve-session, which returns what getSession() resolved. The origin is fixed by env, never taken
 * from the request, so a Host header cannot redirect the credentials.
 */
export function appOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.NEO_APP_ORIGIN?.trim();
  if (configured) return configured;
  // On Vercel the app and the agent share a deployment; VERCEL_URL is set by the platform, not the request.
  if (env.VERCEL_URL) return `https://${env.VERCEL_URL}`;
  return "http://127.0.0.1:3000";
}

export const appSession: AuthFn<Request> = async (request) => {
  const headers = new Headers();
  for (const name of ["cookie", "authorization"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  let res: Response;
  try {
    res = await fetch(new URL("/api/eve-session", appOrigin()), { headers, redirect: "manual", cache: "no-store" });
  } catch {
    // Unreachable app: treat as unauthenticated (401), never as a server error.
    return null;
  }
  if (!res.ok) return null;
  const s = (await res.json()) as { userId?: string; tenantId?: string; role?: string; scopes?: string[] };
  if (!s.userId || !s.tenantId) return null;
  return {
    authenticator: "neo-session",
    principalId: s.userId,
    principalType: "user",
    attributes: { tenantId: s.tenantId, role: s.role ?? "member", scopes: s.scopes ?? [] },
  };
};
