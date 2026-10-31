import { localDev, type AuthFn } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

/**
 * eve runs as its own server (next.config.ts rewrites /eve/v1/* to it), outside Next's request scope, so
 * getSession() cannot run here. Ask the Next app to run it: forward the caller's cookie / Bearer token to
 * /api/eve-session, which returns what getSession() resolved. The origin is fixed by env, never taken
 * from the request, so a Host header cannot redirect the credentials.
 */
const appSession: AuthFn<Request> = async (request) => {
  const origin = process.env.NEO_APP_ORIGIN?.trim() || "http://127.0.0.1:3000";
  const headers = new Headers();
  for (const name of ["cookie", "authorization"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const res = await fetch(new URL("/api/eve-session", origin), { headers, redirect: "manual", cache: "no-store" });
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

export default eveChannel({ auth: [appSession, localDev()] });
