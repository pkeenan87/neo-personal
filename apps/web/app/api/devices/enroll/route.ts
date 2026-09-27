/**
 * POST /api/devices/enroll { code, kind, platform, name, clientVersion }
 *   → 201 { token, tokenId, device, householdName, memberName }
 * No session (_specs/device-enrollment.md): redeems a one-time enrollment code into a device
 * and a monitoring token (scopes device, signals:write, url:check), delivered once.
 * 400 invalid, 404 not_found, 409 device_limit, 429 rate_limited (shared with the preview:
 * 10 per hour per IP), 503 storage_unavailable. The member is emailed.
 */
import { enrollWithCode } from "@/lib/server/device-enrollment";
import { householdRoute } from "@/lib/server/household-http";
import { readJsonObject } from "@/lib/server/http";
import { clientIp } from "@/lib/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const body = await readJsonObject(req);
  const origin = new URL(req.url).origin;
  return householdRoute("api.devices.enroll", "none", () => enrollWithCode(clientIp(req), body, origin), 201);
}
