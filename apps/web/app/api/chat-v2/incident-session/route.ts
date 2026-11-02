import { eveChatEnabled } from "@/lib/env";
import { readJsonObject, jsonError } from "@/lib/server/http";
import { linkIncidentSession } from "@/lib/server/incident-data";
import { requireBrowserApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What eve session ids look like on the wire: opaque, url-safe, bounded. */
const SESSION_ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/;

/**
 * POST /api/chat-v2/incident-session { incidentId, sessionId } → 204.
 * The incident chat reports its eve session so reopening the alert resumes it (`alerts.eve_session_id`).
 * Browser session only; the alert must be in the caller's household and, for a member, about them.
 */
export async function POST(req: Request): Promise<Response> {
  const { session, response } = await requireBrowserApiSession();
  if (!session) return response;
  if (!eveChatEnabled()) return jsonError(404, "Not found.", "not_found");
  const body = await readJsonObject(req);
  const incidentId = body?.incidentId;
  const sessionId = body?.sessionId;
  if (typeof incidentId !== "string" || typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
    return jsonError(400, "incidentId and sessionId are required.", "invalid_request");
  }
  const linked = await linkIncidentSession({ tenantId: session.tenantId, userId: session.userId, role: session.role }, incidentId, sessionId);
  return linked ? new Response(null, { status: 204 }) : jsonError(404, "Not found.", "not_found");
}
