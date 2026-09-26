/**
 * GET  /api/settings/routing → RoutingSettings (the member's preference and family, plus every family's ladder).
 * POST /api/settings/routing { preference?, family? } → 200 RoutingSettings after saving the member's own row.
 *   400 `bad_request` for an unknown value or a family not enabled on this deployment (`NEO_MODEL_FAMILIES`).
 * 401 without a session, 503 `storage_unavailable` when the store fails.
 */
import { logger } from "@neo/core";
import { jsonError, readJsonObject } from "@/lib/server/http";
import {
  isRoutingPreference,
  isSelectableFamily,
  loadRoutingSettings,
  setMemberPreferences,
  type MemberPreferences,
} from "@/lib/server/routing-settings";
import { requireApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fail(tenantId: string, err: unknown): Response {
  logger.error("Routing settings failed", "api.settings.routing", {
    tenantId,
    errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 300),
  });
  return jsonError(503, "Model settings are unavailable right now.", "storage_unavailable");
}

export async function GET(): Promise<Response> {
  const { session, response } = await requireApiSession();
  if (!session) return response;
  try {
    return Response.json(await loadRoutingSettings(session), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return fail(session.tenantId, err);
  }
}

export async function POST(req: Request): Promise<Response> {
  const { session, response } = await requireApiSession();
  if (!session) return response;
  const body = await readJsonObject(req);
  const patch: Partial<MemberPreferences> = {};
  if (body && body.preference !== undefined) {
    if (!isRoutingPreference(body.preference)) return badRequest();
    patch.routingPreference = body.preference;
  }
  if (body && body.family !== undefined) {
    if (!isSelectableFamily(body.family)) return badRequest();
    patch.modelFamily = body.family;
  }
  if (Object.keys(patch).length === 0) return badRequest();
  try {
    await setMemberPreferences(session.tenantId, session.userId, patch);
    return Response.json(await loadRoutingSettings(session), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return fail(session.tenantId, err);
  }
}

function badRequest(): Response {
  return jsonError(
    400,
    'Expected { "preference"?: "cost" | "balanced" | "intelligence", "family"?: an enabled model family }.',
    "bad_request",
  );
}
