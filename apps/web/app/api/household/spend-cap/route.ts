/**
 * GET /api/household/spend-cap → { capCents, spentCents, percent, month, resetAt }
 * PUT /api/household/spend-cap { capCents: number | null } → the same body
 * (browser session, household owner; _specs/v2-m3-cutover.md section 6). `capCents` is the monthly model spend cap in
 * cents, 100 to 1000000; `null` turns it off (the default). 400 `invalid`, `invalid_spend_cap`; 403 `forbidden` (the
 * owner check re-reads the database). PUT audits `household.spend_cap_changed` `{ from, to }`.
 */
import { householdRoute } from "@/lib/server/household-http";
import { readJsonObject } from "@/lib/server/http";
import { getSpendCap, putSpendCap } from "@/lib/server/spend-cap-settings";
import { requireBrowserApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const { session, response } = await requireBrowserApiSession();
  if (!session) return response;
  return householdRoute("api.household.spend_cap.get", session.tenantId, () => getSpendCap(session));
}

export async function PUT(req: Request): Promise<Response> {
  const { session, response } = await requireBrowserApiSession();
  if (!session) return response;
  const body = await readJsonObject(req);
  return householdRoute("api.household.spend_cap.put", session.tenantId, () => putSpendCap(session, body));
}
