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
import { jsonError, readJsonObject } from "@/lib/server/http";
import { requireApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const { session, response } = await requireApiSession({ scope: "device" });
  if (!session) return response;
  // Browser sessions resolve for any scope; only a device's own token may check in.
  const deviceId = session.deviceId;
  if (!deviceId) return jsonError(403, "Only a device's own token can do that.", "insufficient_scope");
  const body = await readJsonObject(req);
  return householdRoute("api.devices.heartbeat", session.tenantId, () => heartbeat(session, deviceId, body, new URL(req.url).origin));
}
