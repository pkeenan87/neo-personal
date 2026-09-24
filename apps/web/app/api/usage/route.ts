/**
 * GET /api/usage — the session tenant's usage against its caps:
 *   { monthlyChecks: { used, limit, resetAt }, dailyTokens: { used, limit, resetAt } }
 * 503 { code: "usage_unavailable" } when the usage store cannot be read.
 */
import { logger } from "@neo/core";
import { jsonError } from "@/lib/server/http";
import { checkCaps, usageSummary } from "@/lib/server/usage";
import { requireApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const { session, response } = await requireApiSession();
  if (!session) return response;
  try {
    const caps = await checkCaps(session.tenantId);
    return Response.json(usageSummary(caps), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    logger.error("Usage read failed", "api.usage", {
      tenantId: session.tenantId,
      errorMessage: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
    });
    return jsonError(503, "Usage is unavailable right now.", "usage_unavailable");
  }
}
