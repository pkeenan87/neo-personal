/** DELETE /api/household/invites/[id] → 204 (owner, browser session); 404 not_found when not pending. */
import { revokeInvite } from "@/lib/server/household";
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
  if (!VERDICT_ID_RE.test(id)) return jsonError(404, "That invite is no longer pending.", "not_found");
  return householdRoute("api.household.invites.revoke", session.tenantId, () => revokeInvite(session, id));
}
