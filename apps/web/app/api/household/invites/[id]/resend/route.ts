/**
 * POST /api/household/invites/[id]/resend → 200 { invite } (owner, browser session).
 * Issues a new secret and expiry for a pending email invite and sends it again;
 * the old link stops working. 404 not_found, 429, 502 email_failed.
 */
import { resendInvite } from "@/lib/server/household";
import { householdRoute } from "@/lib/server/household-http";
import { jsonError } from "@/lib/server/http";
import { VERDICT_ID_RE } from "@/lib/server/verdict-data";
import { requireBrowserApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { session, response } = await requireBrowserApiSession();
  if (!session) return response;
  const { id } = await ctx.params;
  if (!VERDICT_ID_RE.test(id)) return jsonError(404, "That invite is no longer pending.", "not_found");
  return householdRoute("api.household.invites.resend", session.tenantId, () => resendInvite(session, id, new URL(req.url).origin));
}
