/**
 * GET /api/devices/policy/keys → { keys: [{ kid, alg: "ES256", jwk }] } (_specs/v2-m2-child.md section 4).
 * No authentication: these are public keys, for docs and rotation tooling. Clients embed their pinned
 * keys at build time (`NEO_POLICY_PUBKEYS`) and never trust this endpoint to verify a bundle.
 * `Cache-Control: public, max-age=3600`. 503 `policy_signing_unavailable` when no signer is configured.
 */
import { jsonError } from "@/lib/server/http";
import { getPolicySigningService } from "@/lib/server/policy-signer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const signer = getPolicySigningService();
  if (!signer) return jsonError(503, "Policy signing is not configured on this server.", "policy_signing_unavailable");
  try {
    return Response.json({ keys: await signer.publicKeys() }, { status: 200, headers: { "Cache-Control": "public, max-age=3600" } });
  } catch {
    return jsonError(503, "The policy public keys are not available right now.", "policy_signing_unavailable");
  }
}
