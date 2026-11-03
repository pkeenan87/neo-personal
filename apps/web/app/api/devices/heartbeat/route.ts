/**
 * POST /api/devices/heartbeat { clientVersion? } → { device, householdName, memberName, heartbeatSeconds }
 * Scope `device` (a monitoring token; _specs/device-enrollment.md). Records the check-in and
 * re-arms the offline alert. The response also carries `uninstallUrl` (_specs/browser-
 * extension.md), built from the request's own origin. 401 for a revoked device, 403
 * insufficient_scope without a device token, 429 rate_limited (12 per hour per device), 503
 * storage_unavailable.
 */
import { heartbeat } from "@/lib/server/device-enrollment";
import { householdRoute } from "@/lib/server/household-http";
import { readJsonObject } from "@/lib/server/http";
import { requireDeviceSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  // Browser sessions resolve for any scope; only a device's own token may check in.
  const { session, response } = await requireDeviceSession("device");
  if (!session) return response;
  const body = await readJsonObject(req);
  return householdRoute("api.devices.heartbeat", session.tenantId, () => heartbeat(session, session.deviceId, body, new URL(req.url).origin));
}
