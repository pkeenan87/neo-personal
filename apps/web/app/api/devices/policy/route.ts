/**
 * GET /api/devices/policy → { bundle, sig, keyId, alg: "ES256" } (_specs/v2-m2-child.md section 4).
 * Scope `device` (a monitoring token; browser sessions and full-scope tokens get 403
 * `insufficient_scope`). The device and its member come from the token's device. `ETag:
 * "<policyVersion>"`, 304 on a matching `If-None-Match`, `Cache-Control: private, no-cache`.
 * 404 for a revoked device, 429 `rate_limited` (120 per hour per device), 503
 * `policy_signing_unavailable` when no signing key is configured (never an unsigned bundle),
 * 503 `storage_unavailable`.
 */
import { jsonError } from "@/lib/server/http";
import { storageError } from "@/lib/server/dashboard-http";
import { POLICY_CACHE_CONTROL, servePolicy } from "@/lib/server/policy-bundles";
import { rateLimitedResponse } from "@/lib/server/rate-limit";
import { requireDeviceSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const { session, response } = await requireDeviceSession("device");
  if (!session) return response;
  try {
    const r = await servePolicy(session, req.headers.get("if-none-match"));
    if (!r.ok) {
      if (r.status === 429) return rateLimitedResponse(r.retryAfterSeconds ?? 60);
      return jsonError(r.status, r.message, r.code);
    }
    const headers = { ETag: `"${r.policyVersion}"`, "Cache-Control": POLICY_CACHE_CONTROL };
    if (r.status === 304) return new Response(null, { status: 304, headers });
    return Response.json(r.envelope, { status: 200, headers });
  } catch (err) {
    return storageError(err, "api.devices.policy", session.tenantId);
  }
}
