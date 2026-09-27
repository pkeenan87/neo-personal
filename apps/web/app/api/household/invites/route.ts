/**
 * POST /api/household/invites { kind: "email", email } | { kind: "link" } → 201 CreateInviteResponse
 *
 * Owner, browser session. `url` carries the secret and is returned only here.
 * Errors: 400 bad_request | invalid_email | household_full, 403 forbidden |
 * browser_session_required, 409 already_member | invite_pending, 429, 502 email_failed.
 */
import { createInvite } from "@/lib/server/household";
import { householdRoute } from "@/lib/server/household-http";
import { jsonError, readJsonObject } from "@/lib/server/http";
import { requireBrowserApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const { session, response } = await requireBrowserApiSession();
  if (!session) return response;
  const body = await readJsonObject(req);
  const kind = body?.kind;
  if (kind === "email") {
    if (typeof body?.email !== "string") return jsonError(400, 'Expected { "kind": "email", "email": "…" }.', "bad_request");
  } else if (kind !== "link") {
    return jsonError(400, 'Expected { "kind": "email" | "link" }.', "bad_request");
  }
  const input = kind === "email" ? { kind: "email" as const, email: body?.email as string } : { kind: "link" as const };
  return householdRoute("api.household.invites", session.tenantId, () => createInvite(session, input, new URL(req.url).origin), 201);
}
