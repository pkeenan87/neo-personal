/**
 * GET    /api/connectors/outlook -> OutlookView (connection status, the member's own findings; owners also see who in the
 *                                   household is connected and when it was last checked, never an address or mailbox content)
 * DELETE /api/connectors/outlook -> { ok: true, appAccessUrl }
 *
 * Browser session only. DELETE needs a same-origin request. Disconnecting deletes Neo's token and cursor ciphertext and
 * stops scheduled work; it does not revoke Microsoft consent, so the response links to the Microsoft app-access page.
 * It works even when the connector has since been turned off.
 */
import { logger } from "@neo/core";
import { outlookEnv } from "@/lib/env";
import { jsonError } from "@/lib/server/http";
import { getOutlookDeps } from "@/lib/server/outlook/deps";
import { disconnectOutlook, getOutlookView, MICROSOFT_APP_ACCESS_URL } from "@/lib/server/outlook/service";
import { getOutlookStore } from "@/lib/server/outlook/store";
import { isSameOrigin } from "@/lib/server/same-origin";
import { requireBrowserApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function failed(tenantId: string, err: unknown): Response {
  logger.error("Outlook connector request failed", "api.connectors.outlook", { tenantId, errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
  return jsonError(503, "The Outlook connector is unavailable right now.", "storage_unavailable");
}

export async function GET(): Promise<Response> {
  const { session, response } = await requireBrowserApiSession();
  if (!session) return response;
  try {
    return Response.json(await getOutlookView(session, outlookEnv().mode, getOutlookStore()), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return failed(session.tenantId, err);
  }
}

export async function DELETE(req: Request): Promise<Response> {
  const { session, response } = await requireBrowserApiSession();
  if (!session) return response;
  if (!isSameOrigin(req)) return jsonError(403, "Cross-origin requests are not allowed.", "cross_origin");
  try {
    const deps = getOutlookDeps();
    const result = deps ? await disconnectOutlook(session, deps) : { disconnected: await getOutlookStore().disconnect(session.tenantId, session.userId) };
    return Response.json({ ok: true, disconnected: result.disconnected, appAccessUrl: MICROSOFT_APP_ACCESS_URL }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return failed(session.tenantId, err);
  }
}
