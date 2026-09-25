/**
 * GET /api/verdicts/summary?sinceDays=7|30|90&userId
 *   → VerdictSummaryResponse { sinceDays, total, byLabel, bySubjectType, topIndicators, topDomains, perDay }
 *   sinceDays defaults to 30. Same role rules and errors as GET /api/verdicts.
 */
import { SINCE_DAYS, type SinceDays } from "@/lib/dashboard-types";
import { accessErrorResponse, NO_STORE, storageError } from "@/lib/server/dashboard-http";
import { jsonError } from "@/lib/server/http";
import { verdictSummary } from "@/lib/server/verdict-data";
import { requireApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const { session, response } = await requireApiSession();
  if (!session) return response;
  const p = new URL(req.url).searchParams;
  const raw = p.get("sinceDays");
  const sinceDays = raw ? Number(raw) : 30;
  if (!SINCE_DAYS.includes(sinceDays as SinceDays)) return jsonError(400, "sinceDays must be 7, 30 or 90.", "bad_request");
  const userId = p.get("userId") || undefined;
  if (userId && userId.length > 200) return jsonError(400, "Invalid userId.", "bad_request");
  try {
    const result = await verdictSummary(session, { sinceDays: sinceDays as SinceDays, ...(userId ? { userId } : {}) });
    if (!result.ok) return accessErrorResponse(result.error);
    return Response.json(result.value, { headers: NO_STORE });
  } catch (err) {
    return storageError(err, "api.verdicts.summary", session.tenantId);
  }
}
