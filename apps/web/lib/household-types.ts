/** Wire types for the household routes (_specs/household-invites.md). */
import type { ExpectedToolItem } from "./signal-types";
export type { ExpectedToolItem };

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

/** Devices (_specs/device-enrollment.md). */
export type DeviceKind = "browser_extension" | "desktop_agent";
export type DevicePlatform = "chrome" | "edge" | "firefox" | "windows" | "macos" | "linux";

export interface DeviceItem {
  id: string;
  /** The protected member's account; null for a member without one. */
  userId: string | null;
  memberName: string | null;
  kind: DeviceKind;
  platform: DevicePlatform;
  name: string;
  clientVersion: string;
  enrollment: "code" | "self";
  enrolledByName: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  /** `offline` after 48 h without a heartbeat; `never_seen` before the first one. */
  status: "active" | "offline" | "never_seen";
  /** Remote-access tools the owner has marked expected on this device (_specs/signals.md). */
  expectedTools: ExpectedToolItem[];
  /**
   * Whether the device has the current policy bundle (_specs/v2-m2-child.md section 4); set only by the
   * household devices list, absent elsewhere. `pending`: an older bundle is applied. `update_needed`:
   * Child mode is on and the device never reported a version (an older Neo build).
   */
  policy?: DevicePolicyState;
}

export type DevicePolicyState = "current" | "pending" | "update_needed" | "unknown";

export interface EnrollmentCodeItem {
  id: string;
  /** The member's account; null for a member without one. */
  userId: string | null;
  memberName: string | null;
  createdAt: string;
  expiresAt: string;
}

/** POST /api/household/members/[userId]/enrollment-codes; `code` is shown once. */
export interface CreateEnrollmentCodeResponse {
  id: string;
  code: string;
  expiresAt: string;
  memberName: string | null;
}

/** POST /api/devices/enroll/preview */
export interface EnrollmentPreviewResponse {
  householdName: string;
  memberName: string | null;
  ownerName: string | null;
  expiresAt: string;
}

/** POST /api/devices/enroll */
export interface EnrollDeviceResponse {
  token: string;
  tokenId: string;
  device: DeviceItem;
  householdName: string;
  memberName: string | null;
}

/** POST /api/devices/heartbeat */
export interface HeartbeatResponse {
  device: DeviceItem;
  householdName: string;
  memberName: string | null;
  heartbeatSeconds: number;
  /** Detection-lists content version (_specs/signals.md); refetch GET /api/signals/lists when it changed. */
  listsVersion: string;
  /**
   * The current policy bundle version for this device (_specs/v2-m2-child.md section 4); fetch
   * GET /api/devices/policy when it differs from what the device applied. null when it could not be computed.
   */
  policyVersion: string | null;
  /** Present (`true`) only while a command (`end_session`) waits for this device; the bundle then carries it (_specs/v2-m3-cutover.md section 4). */
  pendingCommand?: true;
  /**
   * Present only on a desktop agent's heartbeat when it has a member; whether that member has an active Neo
   * browser extension (_specs/v2-followups.md slice B); the agent reports browser_without_extension on false.
   */
  extensionEnrolled?: boolean;
  /**
   * `<origin>/uninstalled?d=...&s=...` (_specs/browser-extension.md "Uninstall"), passed to
   * `runtime.setUninstallURL`. Absent only when `AUTH_SECRET` is unset on a production
   * deployment (lib/server/uninstall.ts).
   */
  uninstallUrl?: string;
}
