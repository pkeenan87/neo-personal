/**
 * POST /api/household/protected-members { displayName, role, birthYear?, contact? } → 201 member detail
 * (browser session, household owner; _specs/v2-m2-child.md section 2). Creates a member who has no
 * account: role `adult | child | elder`; a child needs a `birthYear`; `contact` (an adult's or elder's
 * email, so they can be a helper) is optional and encrypted at rest. The member starts in Standard mode;
 * turn Child mode on from the member page. Enrollment codes for them come from
 * `/api/household/protected-members/[id]/enrollment-codes`.
 * 400 `invalid`, `invalid_name`, `invalid_birth_year`, `birth_year_required`, `invalid_email`,
 * `contact_not_allowed`; 403 `forbidden` (the owner check re-reads the database); 409 `member_limit`.
 */
import { householdRoute } from "@/lib/server/household-http";
import { readJsonObject } from "@/lib/server/http";
import { createProtectedMember } from "@/lib/server/member-console";
import { requireBrowserApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const { session, response } = await requireBrowserApiSession();
  if (!session) return response;
  const body = await readJsonObject(req);
  return householdRoute("api.household.protected_members.create", session.tenantId, () => createProtectedMember(session, body), 201);
}
