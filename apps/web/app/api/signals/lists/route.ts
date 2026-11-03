/**
 * GET /api/signals/lists → DetectionListsResponse (_specs/signals.md "Detection lists"). Scope
 * `device` + `deviceId` (browser sessions and full-scope tokens get 403 `insufficient_scope`,
 * like every device route). `ETag: "<version>"`, 304 on a matching `If-None-Match` (weak/quoted
 * forms and multi-value lists handled), `Cache-Control: private, max-age=3600` either way.
 */
import { detectionLists } from "@neo/tools";
import { ifNoneMatchHits } from "@/lib/server/if-none-match";
import { requireDeviceSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_CONTROL = "private, max-age=3600";

export async function GET(req: Request): Promise<Response> {
  const { session, response } = await requireDeviceSession("device");
  if (!session) return response;

  const lists = detectionLists();
  const etag = `"${lists.version}"`;
  if (ifNoneMatchHits(req.headers.get("if-none-match"), lists.version)) {
    return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": CACHE_CONTROL } });
  }
  return Response.json(lists, { status: 200, headers: { ETag: etag, "Cache-Control": CACHE_CONTROL } });
}
