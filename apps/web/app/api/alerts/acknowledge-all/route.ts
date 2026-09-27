/** POST /api/alerts/acknowledge-all → 200 { acknowledged } (owner, browser session). */
import { acknowledgeAll } from "@/lib/server/alerts";
import { NO_STORE, storageError } from "@/lib/server/dashboard-http";
import { jsonError } from "@/lib/server/http";
import { requireBrowserApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  const { session, response } = await requireBrowserApiSession();
  if (!session) return response;
  if (session.role !== "owner") return jsonError(403, "Only the household owner can mark alerts as seen.", "forbidden");
  try {
    return Response.json({ acknowledged: await acknowledgeAll(session) }, { headers: NO_STORE });
  } catch (err) {
    return storageError(err, "api.alerts.acknowledge-all", session.tenantId);
  }
}
