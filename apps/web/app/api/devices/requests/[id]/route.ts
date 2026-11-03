/**
 * GET /api/devices/requests/:id → the status of one of this device's own requests (_specs/v2-m2-child.md
 * section 8). Scope `device`. 404 for any other request (another device's or household's, or unknown).
 */
import { getDeviceRequest } from "@/lib/server/child-requests";
import { householdRoute } from "@/lib/server/household-http";
import { requireDeviceSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { session, response } = await requireDeviceSession("device");
  if (!session) return response;
  const { id } = await ctx.params;
  return householdRoute("api.devices.requests.get", session.tenantId, () => getDeviceRequest(session, id));
}
