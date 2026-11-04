/**
 * POST { phone, code } → 200 { channels } (household owner, browser session): confirms the six-digit code sent
 * to that number. 5 wrong codes burn it (persisted); it expires after 10 minutes.
 * 400 invalid_number | invalid_code, 404 not_found, 409 number_unavailable, 410 code_expired, 429 too_many_attempts | rate_limited.
 */
import { z } from "zod";
import { jsonError } from "@/lib/server/http";
import { householdRoute } from "@/lib/server/household-http";
import { confirmMemberSms } from "@/lib/server/member-channels";
import { requireBrowserApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ phone: z.string().max(40), code: z.string().max(16) }).strict();

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { session, response } = await requireBrowserApiSession();
  if (!session) return response;
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(400, "Enter the phone number and the six-digit code.", "invalid_code");
  return householdRoute("api.household.channels.verify", session.tenantId, () => confirmMemberSms(session, id, parsed.data));
}
