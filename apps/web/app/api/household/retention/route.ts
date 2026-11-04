/**
 * GET /api/household/retention → { settings: { signals, incidents, childRequests, memory }, bounds }
 * PUT /api/household/retention { signals, incidents, childRequests, memory } (days) → the same body
 * (browser session, household owner; _specs/v2-m4-hardening.md section 1). 400 `invalid` with `fields` for a missing or
 * out-of-range value; 403 `forbidden` (the owner check re-reads the database). PUT audits `household.retention_changed` `{ from, to }`.
 */
import { householdRoute } from "@/lib/server/household-http";
import { readJsonObject } from "@/lib/server/http";
import { getRetention, putRetention } from "@/lib/server/retention-settings";
import { requireBrowserApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const { session, response } = await requireBrowserApiSession();
  if (!session) return response;
  return householdRoute("api.household.retention.get", session.tenantId, () => getRetention(session));
}

export async function PUT(req: Request): Promise<Response> {
  const { session, response } = await requireBrowserApiSession();
  if (!session) return response;
  const body = await readJsonObject(req);
  return householdRoute("api.household.retention.put", session.tenantId, () => putRetention(session, body));
}
