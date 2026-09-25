/**
 * GET /api/verdicts?label&subjectType&source&userId&cursor&limit
 *   → { items: VerdictListItem[], nextCursor: string | null }   (newest first, keyset cursor, limit 1..50, default 20)
 *   400 bad_request (invalid filter/cursor/limit) · 401 · 403 forbidden (member filtering by another member)
 *   404 not_found (owner filtering by a user outside the household) · 503 storage_unavailable
 * Members always get only their own verdicts.
 */
import { SUBJECT_TYPES, VERDICTS } from "@neo/verdict";
import { VERDICT_SOURCES } from "@/lib/dashboard-types";
import { accessErrorResponse, enumParam, NO_STORE, storageError } from "@/lib/server/dashboard-http";
import { jsonError } from "@/lib/server/http";
import { listVerdicts } from "@/lib/server/verdict-data";
import { decodeVerdictCursor, MAX_VERDICT_PAGE } from "@/lib/server/verdict-memory";
import { requireApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const { session, response } = await requireApiSession();
  if (!session) return response;
  const p = new URL(req.url).searchParams;

  const label = enumParam(p, "label", VERDICTS);
  const subjectType = enumParam(p, "subjectType", SUBJECT_TYPES);
  const source = enumParam(p, "source", VERDICT_SOURCES);
  if (label === null || subjectType === null || source === null) return jsonError(400, "Invalid filter.", "bad_request");

  const rawLimit = p.get("limit");
  const limit = rawLimit ? Number(rawLimit) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > MAX_VERDICT_PAGE)) {
    return jsonError(400, `limit must be 1..${MAX_VERDICT_PAGE}.`, "bad_request");
  }
  const cursor = p.get("cursor") || undefined;
  if (cursor && (cursor.length > 200 || !decodeVerdictCursor(cursor))) return jsonError(400, "Invalid cursor.", "bad_request");
  const userId = p.get("userId") || undefined;
  if (userId && userId.length > 200) return jsonError(400, "Invalid userId.", "bad_request");

  try {
    const result = await listVerdicts(session, {
      ...(label ? { label } : {}),
      ...(subjectType ? { subjectType } : {}),
      ...(source ? { source } : {}),
      ...(cursor ? { cursor } : {}),
      ...(limit ? { limit } : {}),
      ...(userId ? { userId } : {}),
    });
    if (!result.ok) return accessErrorResponse(result.error);
    return Response.json(result.value, { headers: NO_STORE });
  } catch (err) {
    return storageError(err, "api.verdicts", session.tenantId);
  }
}
