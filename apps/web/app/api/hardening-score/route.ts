import { jsonError } from "@/lib/server/http";
import { HardeningScoreError, loadAccountHardeningScore } from "@/lib/server/hardening-score";
import { requireApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The session user's own score. There is no user selector: the subject always comes from the session. */
export async function GET(): Promise<Response> {
  const { session, response } = await requireApiSession();
  if (!session) return response;
  try {
    return Response.json(await loadAccountHardeningScore(session), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof HardeningScoreError) return jsonError(err.status, err.message, err.code);
    throw err;
  }
}
