/**
 * GET /api/household/protected-members/[id]/shared (browser session; _specs/v2-m4-hardening.md section 2) →
 * MemberSharedResponse: what Neo collects for that member given their mode and devices, who sees alerts,
 * retention. An owner, or the member themselves; 403 `forbidden` for another member; 404 `not_found`
 * for an id outside the household.
 */
import { householdRoute } from "@/lib/server/household-http";
import { getMemberShared } from "@/lib/server/member-console";
import { requireBrowserApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { session, response } = await requireBrowserApiSession();
  if (!session) return response;
  const { id } = await ctx.params;
  return householdRoute("api.household.protected_members.shared", session.tenantId, () => getMemberShared(session, id));
}
