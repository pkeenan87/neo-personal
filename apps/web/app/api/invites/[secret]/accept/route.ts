/**
 * POST /api/invites/[secret]/accept { confirmLeave: true } → 200 { tenantId, householdName }
 *
 * Browser session only: a desktop token must never move an account between
 * households. 400 confirm_required, 403 email_mismatch, 404 not_found,
 * 409 already_member | owns_household_with_members | already_in_household, 429.
 */
import { acceptInvite } from "@/lib/server/household";
import { householdRoute } from "@/lib/server/household-http";
import { readJsonObject } from "@/lib/server/http";
import { requireBrowserApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ secret: string }> }): Promise<Response> {
  const { session, response } = await requireBrowserApiSession();
  if (!session) return response;
  const { secret } = await ctx.params;
  const body = await readJsonObject(req);
  const confirmLeave = body?.confirmLeave === true;
  return householdRoute("api.invites.accept", session.tenantId, () => acceptInvite(session, secret, confirmLeave, new URL(req.url).origin));
}
