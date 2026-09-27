/**
 * POST /api/household/leave → 204 (member, browser session). The member's
 * conversations in the household are deleted; their next request gets a fresh
 * one-person household. 400 owner_cannot_leave.
 */
import { leave } from "@/lib/server/household";
import { householdRoute } from "@/lib/server/household-http";
import { requireBrowserApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  const { session, response } = await requireBrowserApiSession();
  if (!session) return response;
  return householdRoute("api.household.leave", session.tenantId, () => leave(session));
}
