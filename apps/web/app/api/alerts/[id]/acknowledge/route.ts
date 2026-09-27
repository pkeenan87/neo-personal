/** POST /api/alerts/[id]/acknowledge → 200 { alert } (owner, browser session); 404 not_found. Idempotent. */
import { acknowledge } from "@/lib/server/alerts";
import { NO_STORE, storageError } from "@/lib/server/dashboard-http";
import { jsonError } from "@/lib/server/http";
import { VERDICT_ID_RE } from "@/lib/server/verdict-data";
import { requireBrowserApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { session, response } = await requireBrowserApiSession();
  if (!session) return response;
  if (session.role !== "owner") return jsonError(403, "Only the household owner can mark alerts as seen.", "forbidden");
  const { id } = await ctx.params;
  if (!VERDICT_ID_RE.test(id)) return jsonError(404, "Alert not found.", "not_found");
  try {
    const alert = await acknowledge(session, id);
    if (!alert) return jsonError(404, "Alert not found.", "not_found");
    return Response.json({ alert }, { headers: NO_STORE });
  } catch (err) {
    return storageError(err, "api.alerts.acknowledge", session.tenantId);
  }
}
