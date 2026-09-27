/**
 * DELETE /api/household/enrollment-codes/[id] → 204 (owner, browser session). Idempotent for a
 * code in the household (already used or cancelled included); 404 not_found for unknown ids.
 */
import { revokeCode } from "@/lib/server/device-enrollment";
import { householdRoute } from "@/lib/server/household-http";
import { jsonError } from "@/lib/server/http";
import { VERDICT_ID_RE } from "@/lib/server/verdict-data";
import { requireBrowserApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { session, response } = await requireBrowserApiSession();
  if (!session) return response;
  const { id } = await ctx.params;
  if (!VERDICT_ID_RE.test(id)) return jsonError(404, "That enrollment code does not exist.", "not_found");
  return householdRoute("api.household.enrollment_codes.revoke", session.tenantId, () => revokeCode(session, id));
}
