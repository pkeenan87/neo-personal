/**
 * GET /api/connectors/outlook/callback?code=&state=  (or ?error=access_denied)
 *
 * Microsoft redirects the member's browser here (_specs/outlook-connector.md). Browser session only. The state is validated
 * and consumed (hash, session user, expiry, single use) before the code is exchanged. Always answers with a redirect to a
 * fixed settings path (absolute, built from `APP_URL`, never from the request URL) carrying an outcome code; Microsoft's `error_description` is never read, logged or echoed.
 * 404 when the connector is not configured.
 */
import { inboundEnv } from "@/lib/env";
import { jsonError } from "@/lib/server/http";
import { getOutlookDeps } from "@/lib/server/outlook/deps";
import { completeOutlookConnect } from "@/lib/server/outlook/service";
import { requireBrowserApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PARAM = 4096;

function param(url: URL, name: string): string | null {
  const v = url.searchParams.get(name);
  return v && v.length <= MAX_PARAM ? v : null;
}

export async function GET(req: Request): Promise<Response> {
  const { session, response } = await requireBrowserApiSession();
  if (!session) return response;
  const deps = getOutlookDeps();
  if (!deps) return jsonError(404, "Not found.", "not_found");
  const url = new URL(req.url);
  const outcome = await completeOutlookConnect(session, { code: param(url, "code"), state: param(url, "state"), error: param(url, "error") }, deps);
  return new Response(null, { status: 303, headers: { Location: new URL(`/settings/outlook?connect=${outcome}`, `${inboundEnv().APP_URL}/`).toString(), "Cache-Control": "no-store" } });
}
