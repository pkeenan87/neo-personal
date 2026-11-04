/**
 * GET|PATCH /api/household/protected-members/[id] (browser session, household owner; _specs/v2-m1-elder.md
 * section 8). The id is a `members` row id, not a user id (`/api/household/members/[userId]` is the
 * remove-a-person route; Next.js does not allow two slug names at one level).
 *
 * GET → { member, contactHint, others, notify, policySummary, isLastOwner }.
 * PATCH { displayName?, role?, mode?, birthYear?, helperMemberIds?, contact? } → the same body. Blank strings
 * and nulls mean "no change"; `contact: null` clears the helper address and `birthYear: null` the birth year.
 * Turning Child or Elder mode on needs `consentTextVersion` (the current text; 400 `consent_required`) and, for Elder,
 * `elderAttestation: true` (400 `attestation_required`; also needed whenever an Elder's helpers change). It records a
 * `monitoring_notice` (and `elder_self_consent`) consent. Child also needs a birth year and the household time zone (400 `birth_year_required`,
 * `time_zone_required`); turning a mode off emails every owner.
 * 400 `invalid`, `invalid_name`, `invalid_birth_year`, `invalid_helper`, `invalid_email`, `has_account`; 403
 * `forbidden` (the owner check re-reads the database); 404 `not_found`; 409 `last_owner`, `owner_role`.
 */
import { householdRoute } from "@/lib/server/household-http";
import { readJsonObject } from "@/lib/server/http";
import { getMemberDetail, patchMember } from "@/lib/server/member-console";
import { requireBrowserApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { session, response } = await requireBrowserApiSession();
  if (!session) return response;
  const { id } = await ctx.params;
  return householdRoute("api.household.protected_members.get", session.tenantId, () => getMemberDetail(session, id));
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { session, response } = await requireBrowserApiSession();
  if (!session) return response;
  const { id } = await ctx.params;
  const body = await readJsonObject(req);
  return householdRoute("api.household.protected_members.patch", session.tenantId, () => patchMember(session, id, body));
}
