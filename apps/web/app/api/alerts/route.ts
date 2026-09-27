/**
 * GET /api/alerts?status=open|all&cursor&limit → AlertListResponse (_specs/owner-alerts.md).
 * Owners see the household's alerts; members only alerts about themselves.
 */
import { NO_STORE, storageError } from "@/lib/server/dashboard-http";
import { BadCursorError, listAlertsForSession } from "@/lib/server/alerts";
import { jsonError } from "@/lib/server/http";
import { requireApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const { session, response } = await requireApiSession();
  if (!session) return response;
  const params = new URL(req.url).searchParams;
  const status = params.get("status") ?? "open";
  if (status !== "open" && status !== "all") return jsonError(400, "status must be open or all.", "bad_request");
  const rawLimit = params.get("limit");
  const limit = rawLimit === null ? 20 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) return jsonError(400, "limit must be 1 to 50.", "bad_request");
  const cursor = params.get("cursor") || undefined;
  try {
    const body = await listAlertsForSession(session, { status, limit, ...(cursor ? { cursor } : {}) });
    return Response.json(body, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof BadCursorError) return jsonError(400, "Invalid cursor.", "bad_request");
    return storageError(err, "api.alerts", session.tenantId);
  }
}
