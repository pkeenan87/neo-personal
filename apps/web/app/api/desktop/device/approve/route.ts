/**
 * POST /api/desktop/device/approve { userCode, approve } → 200 DeviceAuthDecideResponse
 *
 * Browser session only (a desktop token cannot approve another token: 403
 * `browser_session_required`). 404 `not_found` for unknown or expired codes,
 * 409 `already_decided`, 429 `rate_limited` per user (user codes are short).
 */
import { hashPii, logger } from "@neo/core";
import type { DeviceAuthDecideResponse } from "@/lib/desktop-auth-types";
import { DEVICE_DECIDE_LIMIT, decideDeviceAuth } from "@/lib/server/desktop-auth";
import { jsonError, readJsonObject } from "@/lib/server/http";
import { rateLimitedResponse, takeRateSlot } from "@/lib/server/rate-limit";
import { requireBrowserApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const { session, response } = await requireBrowserApiSession();
  if (!session) return response;

  const body = await readJsonObject(req);
  const userCode = typeof body?.userCode === "string" ? body.userCode.trim() : "";
  const approve = body?.approve;
  if (!userCode || userCode.length > 16 || typeof approve !== "boolean") {
    return jsonError(400, 'Expected { "userCode": "XXXX-XXXX", "approve": boolean }.', "bad_request");
  }

  const slot = takeRateSlot("desktop-device-decide", session.userId, DEVICE_DECIDE_LIMIT.limit, DEVICE_DECIDE_LIMIT.windowMs);
  if (!slot.ok) return rateLimitedResponse(slot.retryAfterSeconds);

  try {
    const r = await decideDeviceAuth(session, userCode, approve);
    if (r.decision === "not_found") return jsonError(404, "That code is not valid or has expired. Run the sign-in again on your device.", "not_found");
    if (r.decision === "already_decided") return jsonError(409, "This request was already answered.", "already_decided");
    logger.info(`Desktop sign-in ${r.decision}`, "api.desktop.device.approve", {
      tenantId: session.tenantId,
      userIdHash: hashPii(session.userId),
      clientName: r.clientName,
    });
    const out: DeviceAuthDecideResponse = { status: r.decision, clientName: r.clientName ?? "" };
    return Response.json(out, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    logger.error("Desktop device auth decision failed", "api.desktop.device.approve", {
      tenantId: session.tenantId,
      errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
    return jsonError(503, "Desktop sign-in is unavailable right now.", "storage_unavailable");
  }
}
