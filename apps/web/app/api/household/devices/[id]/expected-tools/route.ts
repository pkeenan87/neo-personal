/**
 * PUT /api/household/devices/[id]/expected-tools { tools: [{ toolId, peerIds }] } → { tools }
 * (browser session, owner; _specs/signals.md "Expected tools"). Replaces the device's whole
 * set. 400 `invalid` | `unknown_tool`, 403 `forbidden` (members), 404 `not_found`.
 */
import { setDeviceExpectedTools } from "@/lib/server/signals/expected-tools";
import { householdRoute } from "@/lib/server/household-http";
import { jsonError, readJsonObject } from "@/lib/server/http";
import { VERDICT_ID_RE } from "@/lib/server/verdict-data";
import { requireBrowserApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { session, response } = await requireBrowserApiSession();
  if (!session) return response;
  const { id } = await ctx.params;
  if (!VERDICT_ID_RE.test(id)) return jsonError(404, "That device is not in your household.", "not_found");
  const body = await readJsonObject(req);
  return householdRoute("api.household.devices.expected_tools", session.tenantId, () => setDeviceExpectedTools(session, id, body));
}
