import { requireApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/eve-session — the caller's own identity as getSession() resolves it (Auth.js cookie, `neo_dt_`
 * Bearer, or DEV_AUTH_BYPASS). Called server-to-server by the eve route-auth function in agent/channels/eve.ts.
 */
export async function GET(): Promise<Response> {
  const { session, response } = await requireApiSession();
  if (!session) return response;
  return Response.json({ userId: session.userId, tenantId: session.tenantId, role: session.role, scopes: session.scopes });
}
