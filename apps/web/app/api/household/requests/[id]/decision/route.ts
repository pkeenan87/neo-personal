/**
 * POST /api/household/requests/[id]/decision { decision: "approve" | "deny", minutes?, scope?, token? } →
 * { request, message } (browser session, household owner re-checked against the database;
 * _specs/v2-m2-child.md section 8). The console buttons and the email-link page both post here.
 * `minutes` (1 to 120, `more_time`) and `scope` (`once` | `always`, `unblock_site`) are the owner's choice;
 * absent, the request's own figure and "once" apply. `token` is the email-link token, checked and spent here.
 * 400 `invalid`, 403 `not_allowed` | `token_invalid`, 404 `not_found`, 409 `already_decided` | `policy_limit`,
 * 410 `expired` | `token_expired`, 503 `storage_unavailable`.
 */
import { decideChildRequest } from "@/lib/server/child-requests";
import { NO_STORE } from "@/lib/server/dashboard-http";
import { jsonError, readJsonObject } from "@/lib/server/http";
import { requireBrowserApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { session, response } = await requireBrowserApiSession();
  if (!session) return response;
  const { id } = await ctx.params;
  const body = await readJsonObject(req);
  const blank = (v: unknown) => v === undefined || v === null || v === "";
  if (!body || (body.decision !== "approve" && body.decision !== "deny")) return jsonError(400, 'Expected { "decision": "approve" | "deny" }.', "invalid");
  const { minutes, scope, token } = body;
  if (!blank(minutes) && (typeof minutes !== "number" || !Number.isFinite(minutes))) return jsonError(400, "minutes must be a number.", "invalid");
  if (!blank(scope) && scope !== "once" && scope !== "always") return jsonError(400, "scope must be once or always.", "invalid");
  if (!blank(token) && (typeof token !== "string" || token.length > 200)) return jsonError(400, "token is not valid.", "invalid");
  const r = await decideChildRequest(session, id, body.decision, {
    via: blank(token) ? "console" : "link",
    ...(!blank(minutes) ? { minutes: minutes as number } : {}),
    ...(scope === "once" || scope === "always" ? { scope } : {}),
    ...(typeof token === "string" && token !== "" ? { token } : {}),
  });
  if (!r.ok) return jsonError(r.status, r.message, r.error);
  return Response.json({ request: r.request, message: r.message }, { headers: NO_STORE });
}
