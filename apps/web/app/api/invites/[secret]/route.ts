/**
 * GET /api/invites/[secret] → 200 InvitePreviewResponse (any signed-in session).
 * 404 not_found for unknown, expired, revoked or used invites; 429 per user.
 * The secret is never logged.
 */
import { previewInvite } from "@/lib/server/household";
import { householdRoute } from "@/lib/server/household-http";
import { requireApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ secret: string }> }): Promise<Response> {
  const { session, response } = await requireApiSession();
  if (!session) return response;
  const { secret } = await ctx.params;
  return householdRoute("api.invites.preview", session.tenantId, () => previewInvite(session, secret));
}
