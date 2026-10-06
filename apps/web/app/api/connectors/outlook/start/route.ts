/**
 * POST /api/connectors/outlook/start -> { authorizeUrl }
 *
 * Starts the Outlook.com connection (_specs/outlook-connector.md). Browser session only (a desktop token is 403): connecting
 * a mailbox must be a deliberate act by the signed-in person. Creates a single-use, 10-minute state bound to the session
 * user. The redirect URI comes only from the environment; there is no returnTo. 503 `connector_unavailable` when the
 * connector is not configured.
 */
import { logger } from "@neo/core";
import { jsonError } from "@/lib/server/http";
import { getOutlookDeps } from "@/lib/server/outlook/deps";
import { startOutlookConnect } from "@/lib/server/outlook/service";
import { isSameOrigin } from "@/lib/server/same-origin";
import { requireBrowserApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const { session, response } = await requireBrowserApiSession();
  if (!session) return response;
  if (!isSameOrigin(req)) return jsonError(403, "Cross-origin requests are not allowed.", "cross_origin");
  const deps = getOutlookDeps();
  if (!deps) return jsonError(503, "The Outlook connector is not available on this server.", "connector_unavailable");
  try {
    return Response.json(await startOutlookConnect(session, deps), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    logger.error("Outlook connect start failed", "api.connectors.outlook", { tenantId: session.tenantId, errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
    return jsonError(503, "Could not start the connection. Try again.", "storage_unavailable");
  }
}
