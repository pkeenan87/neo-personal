/**
 * Device management (browser session; _specs/device-enrollment.md).
 *   PATCH  /api/household/devices/[id] { name } → { device } (owner); 400 invalid, 403 forbidden, 404 not_found
 *   DELETE /api/household/devices/[id] → 204 (owner, or the member it protects); 403 forbidden,
 *          404 not_found (unknown or already removed). Revokes the device's token.
 */
import { removeHouseholdDevice, renameHouseholdDevice } from "@/lib/server/device-enrollment";
import { householdRoute } from "@/lib/server/household-http";
import { jsonError, readJsonObject } from "@/lib/server/http";
import { VERDICT_ID_RE } from "@/lib/server/verdict-data";
import { requireBrowserApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function notFound(): Response {
  return jsonError(404, "That device is not in your household.", "not_found");
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { session, response } = await requireBrowserApiSession();
  if (!session) return response;
  const { id } = await ctx.params;
  if (!VERDICT_ID_RE.test(id)) return notFound();
  const body = await readJsonObject(req);
  return householdRoute("api.household.devices.rename", session.tenantId, () => renameHouseholdDevice(session, id, body?.name));
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { session, response } = await requireBrowserApiSession();
  if (!session) return response;
  const { id } = await ctx.params;
  if (!VERDICT_ID_RE.test(id)) return notFound();
  return householdRoute("api.household.devices.remove", session.tenantId, () => removeHouseholdDevice(session, id));
}
