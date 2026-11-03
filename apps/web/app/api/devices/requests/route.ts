/**
 * POST /api/devices/requests { kind: "more_time" | "unblock_site" | "install_app", detail, reason? } → 201
 * { id, status, expiresAt } (200 with the existing request when an identical one is still pending)
 * GET  /api/devices/requests?status=pending → { requests: DeviceRequestView[] } (this device's own)
 * (_specs/v2-m2-child.md section 8). Scope `device`: the member comes from the device, never from input.
 * detail: more_time { minutes: 5..120 }, unblock_site { domain }, install_app { app: AppRef }; `reason` is at
 * most 140 characters of the child's own text (control characters are removed). 400 `invalid`, 404
 * (revoked device), 409 `not_child_mode`, 429 `too_many_pending` (5 open) or `daily_limit` (20 a UTC day),
 * 503 `storage_unavailable`.
 */
import { createDeviceRequest } from "@/lib/server/child-request-intake";
import { listDeviceRequests } from "@/lib/server/child-requests";
import { householdRoute, outcomeResponse } from "@/lib/server/household-http";
import { storageError } from "@/lib/server/dashboard-http";
import { jsonError, readJsonObject } from "@/lib/server/http";
import { requireDeviceSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const { session, response } = await requireDeviceSession("device");
  if (!session) return response;
  const body = await readJsonObject(req);
  try {
    const r = await createDeviceRequest(session, body);
    if (!r.ok) return outcomeResponse(r);
    const { created, ...view } = r.value;
    return outcomeResponse({ ok: true, value: view }, created ? 201 : 200);
  } catch (err) {
    return storageError(err, "api.devices.requests", session.tenantId);
  }
}

export async function GET(req: Request): Promise<Response> {
  const { session, response } = await requireDeviceSession("device");
  if (!session) return response;
  const status = new URL(req.url).searchParams.get("status");
  if (status !== null && status !== "" && status !== "pending") return jsonError(400, "status must be pending.", "invalid");
  return householdRoute("api.devices.requests", session.tenantId, () => listDeviceRequests(session, status === "pending" ? "pending" : undefined));
}
