/**
 * PUT /api/household/time-zone { timeZone } → { timeZone } (browser session, household owner;
 * _specs/v2-m2-child.md section 2). `timeZone` is an IANA name such as `America/New_York`; the stored
 * value is the canonical name. Screen time, downtime and a child's age band use it. 400 `invalid`,
 * `invalid_time_zone`; 403 `forbidden` (the owner check re-reads the database).
 */
import { householdRoute } from "@/lib/server/household-http";
import { readJsonObject } from "@/lib/server/http";
import { putHouseholdTimeZone } from "@/lib/server/member-console";
import { requireBrowserApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(req: Request): Promise<Response> {
  const { session, response } = await requireBrowserApiSession();
  if (!session) return response;
  const body = await readJsonObject(req);
  return householdRoute("api.household.time_zone.put", session.tenantId, () => putHouseholdTimeZone(session, body));
}
