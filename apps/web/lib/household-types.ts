/** Wire types for the household routes (_specs/household-invites.md). */

export type HouseholdInviteKind = "email" | "link";

export interface HouseholdInviteItem {
  id: string;
  kind: HouseholdInviteKind;
  email: string | null;
  tokenPrefix: string;
  createdAt: string;
  expiresAt: string;
  invitedByName: string | null;
}

/** POST /api/household/invites */
export interface CreateInviteResponse {
  invite: HouseholdInviteItem;
  /** `<origin>/invite/<secret>`; shown once. */
  url: string;
}

/** POST /api/household/invites/[id]/resend */
export interface ResendInviteResponse {
  invite: HouseholdInviteItem;
}

/** GET /api/invites/[secret] */
export interface InvitePreviewResponse {
  householdName: string;
  inviterName: string | null;
  kind: HouseholdInviteKind;
  emailMatches: boolean;
  alreadyMember: boolean;
  currentHousehold: {
    name: string;
    role: "owner" | "member";
    memberCount: number;
    conversationCount: number;
    verdictCount: number;
    hasForwardingAddress: boolean;
  } | null;
}

/** POST /api/invites/[secret]/accept */
export interface AcceptInviteResponse {
  tenantId: string;
  householdName: string;
}

export type InviteErrorCode =
  | "not_found"
  | "email_mismatch"
  | "already_member"
  | "owns_household_with_members"
  | "already_in_household"
  | "confirm_required"
  | "rate_limited"
  | "browser_session_required"
  | "unauthenticated"
  | "storage_unavailable";
