/**
 * ─── STUB: REPLACE IN INTEGRATION PASS ───────────────────────────────
 * Server-side session helper. The integration pass replaces the body of
 * `getSession()` with Auth.js v5 (`auth()` from the NextAuth config) and
 * maps its session to `NeoSession`. Keep the exported names and the
 * `NeoSession` shape; every route and server component depends on them.
 *
 * Current behaviour: returns a fixed dev user when DEV_AUTH_BYPASS=true
 * (never on VERCEL_ENV=production, see lib/env.ts), otherwise `null`.
 * ─────────────────────────────────────────────────────────────────────
 */
import { redirect } from "next/navigation";
import { env } from "./env";

export type MembershipRole = "owner" | "member";

export interface NeoSession {
  userId: string;
  tenantId: string;
  role: MembershipRole;
  email: string;
  name: string;
}

export const DEV_SESSION_IDS = {
  userId: "00000000-0000-4000-8000-000000000001",
  tenantId: "00000000-0000-4000-8000-0000000000aa",
} as const;

export async function getSession(): Promise<NeoSession | null> {
  const e = env();
  if (e.DEV_AUTH_BYPASS) {
    return {
      userId: DEV_SESSION_IDS.userId,
      tenantId: DEV_SESSION_IDS.tenantId,
      role: "owner",
      email: e.DEV_USER_EMAIL,
      name: e.DEV_USER_NAME,
    };
  }
  return null;
}

/** For server components/pages: returns the session or redirects to the landing page. */
export async function requireSession(): Promise<NeoSession> {
  const session = await getSession();
  if (!session) redirect("/?signin=required");
  return session;
}
