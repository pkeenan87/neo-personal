/**
 * PUT /api/household/protected-members/[id]/policy { helpersNotifyAt?, ownersNotifyAt? } (browser
 * session, household owner; _specs/v2-m1-elder.md section 8) → the member detail body.
 * Writes the next `member`-scope policy version: the member's current rules with `notify` merged
 * over them, validated by `PolicyRulesSchema`. Severities: low | medium | high | critical; a blank
 * string keeps the value, `null` removes the member's own setting. 400 `invalid`, 403 `forbidden`, 404 `not_found`.
 */
import { householdRoute } from "@/lib/server/household-http";
import { readJsonObject } from "@/lib/server/http";
import { putMemberPolicy } from "@/lib/server/member-console";
import { requireBrowserApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { session, response } = await requireBrowserApiSession();
  if (!session) return response;
  const { id } = await ctx.params;
  const body = await readJsonObject(req);
  return householdRoute("api.household.protected_members.policy", session.tenantId, () => putMemberPolicy(session, id, body));
}
