/**
 * POST /api/desktop/device { clientName? } → 201 DeviceAuthStartResponse
 *
 * Starts a browser sign-in for a desktop client (device authorization). No
 * session: the caller has nothing yet. Returns a secret device code (to poll
 * /api/desktop/device/token with) and a short user code the person confirms at
 * /desktop/authorize after signing in. 429 `rate_limited` per client IP.
 */
import { logger } from "@neo/core";
import { DESKTOP_AUTH_POLL_INTERVAL_S, DESKTOP_AUTH_TTL_MS } from "@neo/db";
import type { DeviceAuthStartResponse } from "@/lib/desktop-auth-types";
import { DEFAULT_CLIENT_NAME, DEVICE_START_LIMIT, startDeviceAuth } from "@/lib/server/desktop-auth";
import { jsonError, readJsonObject } from "@/lib/server/http";
import { clientIp, rateLimitedResponse, takeRateSlot } from "@/lib/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const slot = takeRateSlot("desktop-device-start", clientIp(req), DEVICE_START_LIMIT.limit, DEVICE_START_LIMIT.windowMs);
  if (!slot.ok) return rateLimitedResponse(slot.retryAfterSeconds);

  const body = (await readJsonObject(req)) ?? {};
  const rawName = body.clientName;
  if (rawName !== undefined && typeof rawName !== "string") return jsonError(400, 'Expected { "clientName"?: string }.', "bad_request");
  const clientName = rawName?.trim() || DEFAULT_CLIENT_NAME;

  try {
    const started = await startDeviceAuth(clientName);
    if ("error" in started) return jsonError(400, "Give the client a short name.", "bad_request");
    const origin = new URL(req.url).origin;
    const verificationUri = `${origin}/desktop/authorize`;
    const out: DeviceAuthStartResponse = {
      deviceCode: started.deviceCode,
      userCode: started.userCode,
      verificationUri,
      verificationUriComplete: `${verificationUri}?code=${encodeURIComponent(started.userCode)}`,
      expiresIn: Math.floor(DESKTOP_AUTH_TTL_MS / 1000),
      interval: DESKTOP_AUTH_POLL_INTERVAL_S,
    };
    return Response.json(out, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    logger.error("Desktop device auth start failed", "api.desktop.device", {
      errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
    return jsonError(503, "Desktop sign-in is unavailable right now.", "storage_unavailable");
  }
}
