/**
 * DELETE /api/household/members/[userId] → 204 (owner, browser session).
 * Deletes the member's conversations in the household, keeps their verdicts,
 * revokes their desktop tokens and emails them. 400 cannot_remove_owner, 404 not_found.
 */
import { removeMember } from "@/lib/server/household";
import { householdRoute } from "@/lib/server/household-http";
import { jsonError } from "@/lib/server/http";
import { requireBrowserApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(req: Request, ctx: { params: Promise<{ userId: string }> }): Promise<Response> {
  const { session, response } = await requireBrowserApiSession();
  if (!session) return response;
  const { userId } = await ctx.params;
  if (!userId || userId.length > 128) return jsonError(404, "That person is not in your household.", "not_found");
  return householdRoute("api.household.members.remove", session.tenantId, () => removeMember(session, userId, new URL(req.url).origin));
}
