/** Wire types for the member console routes (_specs/v2-m1-elder.md section 8, _specs/v2-m2-child.md section 3). */
import type { AppRef, ChildRequestTarget, DowntimeWindow, WebCategory, Weekday, YoutubeLevel } from "@neo/verdict";

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
  /** Only the year is kept; it decides a child's age band. */
  birthYear: number | null;
}

export type AgeBandName = "under_10" | "10_13" | "14_17";

/** A child's settings, every field filled: the age-band defaults with the member's own changes on top. */
export interface ChildSettings {
  web: { categories: WebCategory[]; safeSearch: boolean; youtubeRestricted: YoutubeLevel; allow: string[]; block: string[] };
  apps: { block: AppRef[]; requireApproval: boolean; approved: AppRef[] };
  screenTime: { dailyMinutes: Record<Weekday, number | null>; downtime: DowntimeWindow[]; warnMinutes: number; allowDuringDowntime: AppRef[] };
  childRequestsTo: ChildRequestTarget;
}

/** What the console needs to show and edit Child mode. Present for every member (it is the preview before Child is turned on). */
export interface ChildView {
  birthYear: number | null;
  band: AgeBandName;
  /** True when there is no birth year, so the 10-13 band is assumed. */
  bandAssumed: boolean;
  /** True when the birth year makes the member 18 or older (treated as 14-17). */
  adult: boolean;
  /** The household's IANA time zone; null until an owner confirms it. */
  timeZone: string | null;
  /** The band's defaults (what "Reset to defaults" gives). */
  defaults: ChildSettings;
  /** The settings in force: defaults plus this member's own changes. */
  settings: ChildSettings;
  /** True when the member has saved their own settings (the sections that differ from the defaults are theirs). */
  customized: boolean;
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
  child: ChildView;
  /** True when this is the household's only owner (they stay in Standard mode). */
  isLastOwner: boolean;
}

/** POST /api/household/protected-members { displayName, role, birthYear?, contact? } → 201 MemberDetailResponse */
export type CreatableMemberRole = Exclude<MemberRoleName, "owner">;

/** PUT /api/household/time-zone { timeZone } → { timeZone } */
export interface HouseholdTimeZoneResponse {
  timeZone: string | null;
}
