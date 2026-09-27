/**
 * GET /api/household → { tenantId, name, role, members: [{ userId, name, email, role }], invites, devices, enrollmentCodes }
 * Owners see member emails, pending invites, every active device and pending enrollment
 * codes; members get `email: null` for everyone, `invites: []`, only their own devices and
 * `enrollmentCodes: []` (_specs/dashboard.md, _specs/household-invites.md, _specs/device-enrollment.md).
 */
import type { HouseholdResponse } from "@/lib/dashboard-types";
import { NO_STORE, storageError } from "@/lib/server/dashboard-http";
import { householdDevices } from "@/lib/server/device-enrollment";
import { listInvites } from "@/lib/server/household";
import { household } from "@/lib/server/verdict-data";
import { requireApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const { session, response } = await requireApiSession();
  if (!session) return response;
  try {
    const [summary, invites, devices] = await Promise.all([household(session), listInvites(session), householdDevices(session)]);
    const body: HouseholdResponse = { ...summary, invites, ...devices };
    return Response.json(body, { headers: NO_STORE });
  } catch (err) {
    return storageError(err, "api.household", session.tenantId);
  }
}
