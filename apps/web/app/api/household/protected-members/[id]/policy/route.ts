/**
 * PUT /api/household/protected-members/[id]/policy { helpersNotifyAt?, ownersNotifyAt?, childRequestsTo?, web?, apps?,
 * screenTime? } (browser session, household owner; _specs/v2-m1-elder.md section 8, _specs/v2-m2-child.md section 3)
 * → the member detail body. Writes the next `member`-scope policy version: the member's current rules with
 * the changes merged over them, validated by `PolicyRulesSchema`. Severities: low | medium | high | critical;
 * `childRequestsTo`: owners | helpers. `web`, `apps` and `screenTime` replace their whole section. A blank
 * string keeps the value, `null` removes the member's own setting (the age-band or mode default applies again).
 * 400 `invalid` or `invalid_policy` (with `fields: [{ path, message }]`), 403 `forbidden`, 404 `not_found`.
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
