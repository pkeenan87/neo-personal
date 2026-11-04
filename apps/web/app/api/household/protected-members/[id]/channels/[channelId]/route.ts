/**
 * DELETE → 200 { channels } (household owner, browser session): disconnect a phone (verified or pending).
 * 404 not_found when the channel is not this member's (or NEO_TWILIO_ENABLED is off).
 */
import { householdRoute } from "@/lib/server/household-http";
import { removeMemberSms } from "@/lib/server/member-channels";
import { requireBrowserApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string; channelId: string }> }): Promise<Response> {
  const { session, response } = await requireBrowserApiSession();
  if (!session) return response;
  const { id, channelId } = await ctx.params;
  return householdRoute("api.household.channels.remove", session.tenantId, () => removeMemberSms(session, id, channelId));
}
