/**
 * POST /api/devices/check-url { url } → { rating, domain, reasons, checkedAt }
 * (_specs/browser-extension.md "On-demand check"). Scope `url:check` + `deviceId` (a
 * monitoring token; browser sessions and full-scope tokens get 403 `insufficient_scope`,
 * like every device route). Not saved as a verdict, raises no alert, and does not count
 * against the household's monthly checks. 400 `invalid` for a bad url; 429 `rate_limited`
 * (30/hour and 200/UTC-day per device) with Retry-After.
 */
import { checkUrl } from "@/lib/server/signals/check-url";
import { householdRoute } from "@/lib/server/household-http";
import { jsonError, readJsonObject } from "@/lib/server/http";
import { requireApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const { session, response } = await requireApiSession({ scope: "url:check" });
  if (!session) return response;
  const deviceId = session.deviceId;
  if (!deviceId) return jsonError(403, "Only a device's own token can do that.", "insufficient_scope");
  const body = await readJsonObject(req);
  return householdRoute("api.devices.check-url", session.tenantId, () => checkUrl(session, deviceId, body));
}
