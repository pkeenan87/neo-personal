/**
 * POST /api/verdicts/[id]/signin-response { response: "yes" | "no" } → 200 { ok: true, playbook? }
 *
 * The "Was this you?" answer on a sign-in alert verdict (_specs/signin-alerts.md). Browser sessions only.
 * Only the verdict's own member may answer (404 for anyone else, owners included); idempotent, last answer
 * wins; 409 `no_signin_check` when the verdict has no sign-in check. "no" returns `playbook: "account_takeover"`.
 */
import { NO_STORE, storageError } from "@/lib/server/dashboard-http";
import { jsonError, readJsonObject } from "@/lib/server/http";
import { answerSigninCheck } from "@/lib/server/signin/service";
import { requireBrowserApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const { session, response } = await requireBrowserApiSession();
  if (!session) return response;
  const body = await readJsonObject(req);
  const answer = body?.response;
  if (!body || Object.keys(body).some((k) => k !== "response") || (answer !== "yes" && answer !== "no")) {
    return jsonError(400, 'Expected { "response": "yes" | "no" }.', "bad_request");
  }
  const { id } = await ctx.params;
  try {
    const result = await answerSigninCheck(session, id, answer);
    if (result.status === "not_found") return jsonError(404, "Verdict not found.", "not_found");
    if (result.status === "no_check") return jsonError(409, "This verdict has no sign-in question.", "no_signin_check");
    return Response.json({ ok: true, ...(result.playbook ? { playbook: result.playbook } : {}) }, { headers: NO_STORE });
  } catch (err) {
    return storageError(err, "api.verdicts.signin-response", session.tenantId);
  }
}
