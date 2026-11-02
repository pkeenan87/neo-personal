/** Wire types for the member console routes (_specs/v2-m1-elder.md section 8). */

export type MemberRoleName = "owner" | "adult" | "child" | "elder";
export type MemberModeName = "standard" | "child" | "elder";
export type NotifySeverity = "low" | "medium" | "high" | "critical";
export const NOTIFY_SEVERITIES: readonly NotifySeverity[] = ["low", "medium", "high", "critical"];

/** One household member as the owner's console shows them. Never carries a contact address. */
export interface MemberProfile {
  id: string;
  displayName: string;
  role: MemberRoleName;
  mode: MemberModeName;
  /** True when the member signs in (a helper contact email is then not used). */
  hasAccount: boolean;
  helperMemberIds: string[];
  /** True when a helper contact email is stored (members without an account only). */
  hasContact: boolean;
}

/** GET /api/household/protected-members */
export interface MemberListResponse {
  members: MemberProfile[];
}

/** GET|PATCH /api/household/protected-members/[id], PUT .../policy */
export interface MemberDetailResponse {
  member: MemberProfile;
  /** Masked helper contact address (`a***@example.com`), or null. */
  contactHint: string | null;
  /** The other members, for the helper picker. */
  others: { id: string; displayName: string; hasAccount: boolean }[];
  /** Effective notify thresholds (mode defaults, then this member's own policy). */
  notify: { helpersNotifyAt: NotifySeverity; ownersNotifyAt: NotifySeverity };
  /** The effective policy in plain words. */
  policySummary: string[];
  /** True when this is the household's only owner (they stay in Standard mode). */
  isLastOwner: boolean;
}
