/**
 * GET /api/household/requests?memberId=&status= → { requests: ChildRequestItem[] } (browser session,
 * household owner; _specs/v2-m2-child.md section 8). Pending first, then newest; at most 50. `reason` is
 * the child's own text: show it quoted. 403 `forbidden`, 400 `invalid` for a bad status.
 */
import { CHILD_REQUEST_STATUSES } from "@neo/db";
import { enumParam } from "@/lib/server/dashboard-http";
import { listHouseholdRequests } from "@/lib/server/child-requests";
import { householdRoute } from "@/lib/server/household-http";
import { jsonError } from "@/lib/server/http";
import { requireBrowserApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const { session, response } = await requireBrowserApiSession();
  if (!session) return response;
  const params = new URL(req.url).searchParams;
  const status = enumParam(params, "status", CHILD_REQUEST_STATUSES);
  if (status === null) return jsonError(400, "status must be pending, approved, denied or expired.", "invalid");
  const memberId = params.get("memberId") ?? undefined;
  return householdRoute("api.household.requests", session.tenantId, () =>
    listHouseholdRequests(session, { ...(memberId ? { memberId } : {}), ...(status ? { status } : {}) }),
  );
}
