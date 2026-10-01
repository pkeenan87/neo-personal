/**
 * POST /api/devices/uninstalled { d, s } → 204 (_specs/browser-extension.md "Uninstall").
 * No auth: the heartbeat response is the only place `s` (an HMAC signature of the device id)
 * is ever handed out, so a request the extension never sent cannot revoke anything. Always
 * 204 for a well-formed body — a bad signature, an unknown device, or one already removed
 * changes nothing but still answers 204, so the response reveals nothing either way. 400
 * `bad_request` only for a malformed body. 10/hour/IP.
 */
import { reportUninstalled } from "@/lib/server/device-enrollment";
import { jsonError, readJsonObject } from "@/lib/server/http";
import { clientIp, rateLimitedResponse, takeRateSlot } from "@/lib/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIMIT = { limit: 10, windowMs: 60 * 60 * 1000 } as const;
const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function POST(req: Request): Promise<Response> {
  const slot = takeRateSlot("device-uninstalled", clientIp(req), LIMIT.limit, LIMIT.windowMs);
  if (!slot.ok) return rateLimitedResponse(slot.retryAfterSeconds);

  const body = await readJsonObject(req);
  const d = body?.d;
  const s = body?.s;
  if (typeof d !== "string" || !d || typeof s !== "string" || !s) {
    return jsonError(400, 'Expected { "d": string, "s": string }.', "bad_request");
  }

  await reportUninstalled(d, s);
  return new Response(null, { status: 204, headers: NO_STORE });
}
