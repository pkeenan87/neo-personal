/**
 * GET  /api/settings/forwarding → ForwardingSettings (creates the household address on first call).
 * POST /api/settings/forwarding { action: "rotate" } → 200 ForwardingSettings with the new address.
 *   403 `forbidden` for non-owners, 400 `bad_request` for any other body.
 * 401 without a session, 503 `storage_unavailable` when the store fails.
 */
import { logger } from "@neo/core";
import { jsonError, readJsonObject } from "@/lib/server/http";
import { loadForwardingSettings, rotateForwardingAddress } from "@/lib/server/inbound/forwarding-settings";
import { requireApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fail(tenantId: string, err: unknown): Response {
  logger.error("Forwarding settings failed", "api.settings.forwarding", {
    tenantId,
    errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 300),
  });
  return jsonError(503, "Forwarding settings are unavailable right now.", "storage_unavailable");
}

export async function GET(): Promise<Response> {
  const { session, response } = await requireApiSession();
  if (!session) return response;
  try {
    return Response.json(await loadForwardingSettings(session), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return fail(session.tenantId, err);
  }
}

export async function POST(req: Request): Promise<Response> {
  const { session, response } = await requireApiSession();
  if (!session) return response;
  const body = await readJsonObject(req);
  if (!body || body.action !== "rotate") return jsonError(400, 'Expected { "action": "rotate" }.', "bad_request");
  if (session.role !== "owner") return jsonError(403, "Only the household owner can rotate the address.", "forbidden");
  try {
    await rotateForwardingAddress(session);
    return Response.json(await loadForwardingSettings(session), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return fail(session.tenantId, err);
  }
}
