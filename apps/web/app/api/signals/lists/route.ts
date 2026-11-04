/**
 * GET /api/signals/lists → DetectionListsResponse (_specs/signals.md "Detection lists"). Scope
 * `device` + `deviceId` (browser sessions and full-scope tokens get 403 `insufficient_scope`,
 * like every device route). `ETag: "<version>"`, 304 on a matching `If-None-Match` (weak/quoted
 * forms and multi-value lists handled), `Cache-Control: private, max-age=3600` either way.
 * `version` (and so the ETag and the heartbeat's `listsVersion`) also covers the category lists, so a
 * client that holds the old response sees the new `categoryLists`; `categoryLists` is additive.
 */
import { detectionLists } from "@neo/tools";
import { categoryListsInfo, combinedListsVersion } from "@/lib/server/category-lists";
import { ifNoneMatchHits } from "@/lib/server/if-none-match";
import { requireDeviceSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_CONTROL = "private, max-age=3600";

export async function GET(req: Request): Promise<Response> {
  const { session, response } = await requireDeviceSession("device");
  if (!session) return response;

  const lists = detectionLists();
  const version = combinedListsVersion(lists.version);
  const etag = `"${version}"`;
  if (ifNoneMatchHits(req.headers.get("if-none-match"), version)) {
    return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": CACHE_CONTROL } });
  }
  const body = { ...lists, version, categoryLists: categoryListsInfo(new URL(req.url).origin) };
  return Response.json(body, { status: 200, headers: { ETag: etag, "Cache-Control": CACHE_CONTROL } });
}
