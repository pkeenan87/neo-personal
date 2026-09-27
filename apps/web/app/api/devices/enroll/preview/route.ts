/**
 * POST /api/devices/enroll/preview { code } → { householdName, memberName, ownerName, expiresAt }
 * No session (_specs/device-enrollment.md): lets the client ask for consent before redeeming.
 * 400 invalid, 404 not_found (unknown, expired, cancelled or used), 429 rate_limited
 * (shared with /api/devices/enroll: 10 per hour per IP), 503 storage_unavailable.
 */
import { previewEnrollment } from "@/lib/server/device-enrollment";
import { householdRoute } from "@/lib/server/household-http";
import { readJsonObject } from "@/lib/server/http";
import { clientIp } from "@/lib/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const body = await readJsonObject(req);
  // No tenant is known before the code resolves.
  return householdRoute("api.devices.enroll.preview", "none", () => previewEnrollment(clientIp(req), body));
}
