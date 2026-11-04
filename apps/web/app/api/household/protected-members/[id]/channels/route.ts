/**
 * Connect a phone (SMS) to a member (household owner, browser session; _specs/v2-m3-cutover.md section 5).
 * The id is a `members` row id.
 *   GET  → 200 { channels: [{ id, channel, display, verified, verificationExpiresAt }] }
 *   POST { phone } → 200 same shape: stores an unverified claim and sends a six-digit code (mock-only tonight).
 * 400 invalid_number, 403 forbidden, 404 not_found (also when NEO_TWILIO_ENABLED is off), 409 channel_limit |
 * number_unavailable, 429 rate_limited. Numbers are never logged, only hashed.
 */
import { z } from "zod";
import { jsonError } from "@/lib/server/http";
import { householdRoute } from "@/lib/server/household-http";
import { listMemberSmsChannels, startMemberSms } from "@/lib/server/member-channels";
import { requireBrowserApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ phone: z.string().max(40) }).strict();

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { session, response } = await requireBrowserApiSession();
  if (!session) return response;
  const { id } = await ctx.params;
  return householdRoute("api.household.channels.list", session.tenantId, () => listMemberSmsChannels(session, id));
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { session, response } = await requireBrowserApiSession();
  if (!session) return response;
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(400, "Enter a phone number with its country code.", "invalid_number");
  return householdRoute("api.household.channels.start", session.tenantId, () => startMemberSms(session, id, parsed.data));
}
