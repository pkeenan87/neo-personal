/**
 * POST /api/household/protected-members/[id]/enrollment-codes → 201 { id, code, expiresAt, memberName }
 * (household owner, browser session; _specs/v2-m2-child.md section 2). The id is a `members` row id: the
 * code can target any member of the household, including one without an account. Same response as
 * /api/household/members/[userId]/enrollment-codes; the code is shown once.
 * 403 forbidden (the owner check re-reads the database), 404 not_found (unknown id or another
 * household's member), 409 code_limit | device_limit.
 */
import { createCodeForMember } from "@/lib/server/device-enrollment";
import { householdRoute } from "@/lib/server/household-http";
import { requireBrowserApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { session, response } = await requireBrowserApiSession();
  if (!session) return response;
  const { id } = await ctx.params;
  return householdRoute("api.household.protected_members.enrollment_codes.create", session.tenantId, () => createCodeForMember(session, id), 201);
}
