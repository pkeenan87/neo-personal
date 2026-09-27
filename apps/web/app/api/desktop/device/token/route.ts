/**
 * POST /api/desktop/device/token { deviceCode }
 *   200 DeviceAuthRedeemResponse  approved: the desktop token, delivered once, with its
 *       `scopes` and, for a monitoring request, the enrolled `device`
 *   202 { status: "pending", interval }
 *   403 `denied`, 410 `expired`, 404 `not_found` (unknown, or already redeemed)
 *   400 `token_limit` when the approver already has the maximum number of tokens
 *   409 `device_limit` when the household already has the maximum number of devices
 *   429 `rate_limited` per client IP, 503 `storage_unavailable`
 */
import { logger } from "@neo/core";
import { DESKTOP_AUTH_POLL_INTERVAL_S } from "@neo/db";
import type { DeviceAuthPendingResponse, DeviceAuthRedeemResponse } from "@/lib/desktop-auth-types";
import { DEVICE_REDEEM_LIMIT, redeemDeviceAuth } from "@/lib/server/desktop-auth";
import { toDeviceItem } from "@/lib/server/devices";
import { jsonError, readJsonObject } from "@/lib/server/http";
import { clientIp, rateLimitedResponse, takeRateSlot } from "@/lib/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const slot = takeRateSlot("desktop-device-redeem", clientIp(req), DEVICE_REDEEM_LIMIT.limit, DEVICE_REDEEM_LIMIT.windowMs);
  if (!slot.ok) return rateLimitedResponse(slot.retryAfterSeconds);

  const body = await readJsonObject(req);
  const deviceCode = typeof body?.deviceCode === "string" ? body.deviceCode.trim() : "";
  if (!deviceCode || deviceCode.length > 128) return jsonError(400, 'Expected { "deviceCode": string }.', "bad_request");

  try {
    const r = await redeemDeviceAuth(deviceCode);
    switch (r.status) {
      case "pending": {
        const out: DeviceAuthPendingResponse = { status: "pending", interval: DESKTOP_AUTH_POLL_INTERVAL_S };
        return Response.json(out, { status: 202, headers: { "Cache-Control": "no-store" } });
      }
      case "approved": {
        const out: DeviceAuthRedeemResponse = {
          status: "approved",
          token: r.token,
          tokenId: r.record.id,
          clientName: r.clientName,
          email: r.email,
          name: r.name,
          scopes: [...r.scopes],
          device: r.device ? toDeviceItem(r.device) : null,
        };
        return Response.json(out, { headers: { "Cache-Control": "no-store" } });
      }
      case "denied":
        return jsonError(403, "The sign-in was declined in the browser.", "denied");
      case "expired":
        return jsonError(410, "This sign-in request expired. Start again.", "expired");
      case "token_limit":
        return jsonError(400, "That account already has the maximum number of desktop tokens. Revoke one under Settings → Desktop.", "token_limit");
      case "device_limit":
        return jsonError(409, "This household already has the maximum number of devices. Remove one under Settings → Household.", "device_limit");
      default:
        return jsonError(404, "Unknown sign-in request.", "not_found");
    }
  } catch (err) {
    logger.error("Desktop device auth redeem failed", "api.desktop.device.token", {
      errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
    return jsonError(503, "Desktop sign-in is unavailable right now.", "storage_unavailable");
  }
}
