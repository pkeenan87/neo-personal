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
  userId: string;
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
}

export interface EnrollmentCodeItem {
  id: string;
  userId: string;
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
   * `<origin>/uninstalled?d=...&s=...` (_specs/browser-extension.md "Uninstall"), passed to
   * `runtime.setUninstallURL`. Absent only when `AUTH_SECRET` is unset on a production
   * deployment (lib/server/uninstall.ts).
   */
  uninstallUrl?: string;
}
