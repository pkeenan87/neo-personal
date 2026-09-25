/**
 * GET    /api/verdicts/[id] → VerdictDetailResponse (row + body + conversation/artifact/inbound)
 * DELETE /api/verdicts/[id] → 204; also deletes the linked artifact; audit event `verdict.deleted`
 *
 * 404 not_found for malformed ids, other tenants' verdicts, and (for members)
 * other members' verdicts. Owners may read and delete any verdict in the household.
 */
import { NO_STORE, storageError } from "@/lib/server/dashboard-http";
import { jsonError } from "@/lib/server/http";
import { deleteVerdict, verdictDetail } from "@/lib/server/verdict-data";
import { requireApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  const { session, response } = await requireApiSession();
  if (!session) return response;
  const { id } = await ctx.params;
  try {
    const detail = await verdictDetail(session, id);
    if (!detail) return jsonError(404, "Verdict not found.", "not_found");
    return Response.json(detail, { headers: NO_STORE });
  } catch (err) {
    return storageError(err, "api.verdicts.id", session.tenantId);
  }
}

export async function DELETE(_req: Request, ctx: Ctx): Promise<Response> {
  const { session, response } = await requireApiSession();
  if (!session) return response;
  const { id } = await ctx.params;
  try {
    if (!(await deleteVerdict(session, id))) return jsonError(404, "Verdict not found.", "not_found");
    return new Response(null, { status: 204 });
  } catch (err) {
    return storageError(err, "api.verdicts.id", session.tenantId);
  }
}
