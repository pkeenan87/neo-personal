/**
 * GET /api/signals/status?ids=<uuid>,<uuid> → { results } (_specs/browser-extension.md
 * "Signal status"). Scope `signals:write` + `deviceId`, same as POST /api/signals: a
 * full-scope desktop token or a browser session gets 403 `insufficient_scope`. 1-50 uuids
 * else 400 `bad_request`; only this device's events; unknown ids omitted; 120/hour/device.
 */
import { signalStatus } from "@/lib/server/signals/status";
import { householdRoute } from "@/lib/server/household-http";
import { requireDeviceSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const { session, response } = await requireDeviceSession("signals:write");
  if (!session) return response;
  const idsParam = new URL(req.url).searchParams.get("ids");
  return householdRoute("api.signals.status", session.tenantId, () => signalStatus(session, session.deviceId, idsParam));
}
