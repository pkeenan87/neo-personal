/**
 * POST /api/household/members/[userId]/enrollment-codes → 201 { id, code, expiresAt, memberName }
 * (owner, browser session; _specs/device-enrollment.md). The code is shown once.
 * 403 forbidden (members), 404 not_found, 409 code_limit | device_limit.
 */
import { createCode } from "@/lib/server/device-enrollment";
import { householdRoute } from "@/lib/server/household-http";
import { jsonError } from "@/lib/server/http";
import { requireBrowserApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ userId: string }> }): Promise<Response> {
  const { session, response } = await requireBrowserApiSession();
  if (!session) return response;
  const { userId } = await ctx.params;
  if (!userId || userId.length > 128) return jsonError(404, "That person is not in your household.", "not_found");
  return householdRoute("api.household.enrollment_codes.create", session.tenantId, () => createCode(session, userId), 201);
}
