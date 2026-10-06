import { CURRENT_ACCOUNT_HARDENING_VERSION, isAccountHardeningAnswerAllowed, isAccountHardeningItemId } from "@neo/core";
import { jsonError, readJsonObject } from "@/lib/server/http";
import { clearAccountHardeningAnswer, HardeningScoreError, setAccountHardeningAnswer } from "@/lib/server/hardening-score";
import { requireBrowserApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BODY_KEYS = new Set(["itemId", "checklistVersion", "value"]);

/** The only answer mutation. Browser sessions only: a desktop or monitoring token gets 403. */
export async function POST(req: Request): Promise<Response> {
  const { session, response } = await requireBrowserApiSession();
  if (!session) return response;
  const body = await readJsonObject(req);
  const { itemId, checklistVersion, value } = body ?? {};
  if (!body || Object.keys(body).some(k => !BODY_KEYS.has(k)) || typeof checklistVersion !== "string" || !isAccountHardeningItemId(itemId)
    || (value !== "clear" && !isAccountHardeningAnswerAllowed(itemId, value))) {
    return jsonError(400, 'Expected { "itemId", "checklistVersion", "value": true | false | "not_applicable" | "clear" } for an answerable item.', "bad_request");
  }
  // Checked before any write, for set and clear alike.
  if (checklistVersion !== CURRENT_ACCOUNT_HARDENING_VERSION) {
    return jsonError(409, "The checklist changed. Reload the page and answer again.", "checklist_version_mismatch");
  }
  try {
    const score = value === "clear"
      ? await clearAccountHardeningAnswer(session, itemId)
      : await setAccountHardeningAnswer(session, { itemId, checklistVersion, value });
    return Response.json(score, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof HardeningScoreError) return jsonError(err.status, err.message, err.code);
    throw err;
  }
}
