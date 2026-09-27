/**
 * DELETE /api/devices/self → 204. Scope `device` (_specs/device-enrollment.md): "Stop protecting
 * this device" and the agent's uninstaller. Revokes the device and its token, and raises a high
 * `device_removed` alert unless the device protects an owner. 403 insufficient_scope without a
 * device token, 503 storage_unavailable.
 */
import { unenrollSelf } from "@/lib/server/device-enrollment";
import { householdRoute } from "@/lib/server/household-http";
import { jsonError } from "@/lib/server/http";
import { requireApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(): Promise<Response> {
  const { session, response } = await requireApiSession({ scope: "device" });
  if (!session) return response;
  const deviceId = session.deviceId;
  if (!deviceId) return jsonError(403, "Only a device's own token can do that.", "insufficient_scope");
  return householdRoute("api.devices.self", session.tenantId, () => unenrollSelf(session, deviceId));
}
