/**
 * POST /api/signals { events } → { results } (_specs/signals.md "Ingest"). Scope
 * `signals:write` + `deviceId` (browser sessions resolve for any scope, so a device route must
 * also check `session.deviceId`; a full-scope desktop token or a browser session both get 403
 * `insufficient_scope`). 400 `bad_request` for a malformed body; 429 at 60 requests/hour/device;
 * 503 `storage_unavailable` on a storage failure.
 */
import { ingestSignals } from "@/lib/server/signals/ingest";
import { householdRoute } from "@/lib/server/household-http";
import { jsonError, readJsonObject } from "@/lib/server/http";
import { requireApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const { session, response } = await requireApiSession({ scope: "signals:write" });
  if (!session) return response;
  const deviceId = session.deviceId;
  if (!deviceId) return jsonError(403, "Only a device's own token can do that.", "insufficient_scope");
  const body = await readJsonObject(req);
  return householdRoute("api.signals.ingest", session.tenantId, () => ingestSignals(session, deviceId, body));
}
