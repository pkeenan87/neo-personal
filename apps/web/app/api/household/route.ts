/**
 * GET /api/household → { tenantId, name, role, members: [{ userId, name, email, role }], invites }
 * Owners see member emails and pending invites; members get `email: null` for
 * everyone and `invites: []` (_specs/dashboard.md, _specs/household-invites.md).
 */
import type { HouseholdResponse } from "@/lib/dashboard-types";
import { NO_STORE, storageError } from "@/lib/server/dashboard-http";
import { listInvites } from "@/lib/server/household";
import { household } from "@/lib/server/verdict-data";
import { requireApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const { session, response } = await requireApiSession();
  if (!session) return response;
  try {
    const [summary, invites] = await Promise.all([household(session), listInvites(session)]);
    // devices / enrollmentCodes: filled by the device routes (_specs/device-enrollment.md).
    const body: HouseholdResponse = { ...summary, invites, devices: [], enrollmentCodes: [] };
    return Response.json(body, { headers: NO_STORE });
  } catch (err) {
    return storageError(err, "api.household", session.tenantId);
  }
}
