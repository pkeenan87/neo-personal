/** Response helpers for the household routes (_specs/household-invites.md). */
import { NO_STORE, storageError } from "./dashboard-http";
import type { Outcome } from "./household";
import { jsonError } from "./http";
import { rateLimitedResponse } from "./rate-limit";

/** JSON (or an empty 204 for `null`) on success; the outcome's status and code otherwise. */
export function outcomeResponse<T>(r: Outcome<T>, successStatus = 200): Response {
  if (!r.ok) {
    if (r.status === 429) return rateLimitedResponse(r.retryAfterSeconds ?? 60);
    return jsonError(r.status, r.message, r.code);
  }
  if (r.value === null) return new Response(null, { status: 204, headers: NO_STORE });
  return Response.json(r.value, { status: successStatus, headers: NO_STORE });
}

/** Run a household operation, mapping storage failures to 503 `storage_unavailable`. */
export async function householdRoute<T>(route: string, tenantId: string, fn: () => Promise<Outcome<T>>, successStatus = 200): Promise<Response> {
  try {
    return outcomeResponse(await fn(), successStatus);
  } catch (err) {
    return storageError(err, route, tenantId);
  }
}
