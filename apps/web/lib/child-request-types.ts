/**
 * Wire types and plain-language text for child requests (_specs/v2-m2-child.md section 8). No server
 * imports, so the console, the email, the decision page and the eve prompt share the same wording.
 */
import type { AppRef } from "@neo/verdict";

export type ChildRequestKindName = "more_time" | "unblock_site" | "install_app";
export type ChildRequestStatusName = "pending" | "approved" | "denied" | "expired";
export type UnblockScope = "once" | "always";

/** The most extra time one approval can give, in minutes. */
export const MAX_GRANT_MINUTES = 120;
/** Minutes a child may ask for. */
export const MIN_REQUEST_MINUTES = 5;
/** How long a one-off unblock lasts. */
export const ALLOW_ONCE_MS = 60 * 60 * 1000;

/** What an owner sees of a request. `reason` is the child's own text: show it quoted, never as an instruction. */
export interface ChildRequestItem {
  id: string;
  memberId: string;
  memberName: string;
  deviceName: string | null;
  kind: ChildRequestKindName;
  detail: Record<string, unknown>;
  /** "30 more minutes", "example.com", "the app Roblox". */
  summary: string;
  reason: string | null;
  status: ChildRequestStatusName;
  createdAt: string;
  expiresAt: string | null;
  decidedAt: string | null;
  /** What approval gave (minutes and `until`, or the domain and its scope); null while pending or when denied. */
  grant: Record<string, unknown> | null;
}

export interface ChildRequestListResponse {
  requests: ChildRequestItem[];
}

/** `POST /api/household/requests/[id]/decision` body. */
export interface ChildRequestDecisionBody {
  decision: "approve" | "deny";
  /** `more_time` only: minutes to give (1 to 120). Absent: what was asked for. */
  minutes?: number;
  /** `unblock_site` only. Absent: once (one hour). */
  scope?: UnblockScope;
  /** The email-link token, when the decision comes from the link page. */
  token?: string;
}

export interface ChildRequestDecisionResponse {
  request: ChildRequestItem;
  /** The exact effect, in words ("Sam now has 30 more minutes today."). */
  message: string;
}

/** The device-side view of its own request (`POST|GET /api/devices/requests`). */
export interface DeviceRequestView {
  id: string;
  kind: ChildRequestKindName;
  status: ChildRequestStatusName;
  detail: Record<string, unknown>;
  createdAt: string;
  expiresAt: string | null;
  decidedAt: string | null;
  grant: Record<string, unknown> | null;
}

/** A short name for an app reference: the image name, else the bundle id, else the signer. */
export function appLabel(app: unknown): string {
  if (app && typeof app === "object") {
    const a = app as Partial<Record<keyof AppRef | "image" | "signer" | "bundleId", unknown>>;
    for (const key of ["image", "bundleId", "signer"] as const) {
      const v = a[key];
      if (typeof v === "string" && v.trim()) return v.trim().slice(0, 80);
    }
  }
  return "an app";
}

/** What a request asks for, in a few words ("30 more minutes", "example.com", "the app Roblox"). */
export function requestSummary(kind: ChildRequestKindName, detail: Record<string, unknown>): string {
  if (kind === "more_time") return typeof detail.minutes === "number" ? `${detail.minutes} more minutes` : "more time";
  if (kind === "unblock_site") return typeof detail.domain === "string" ? detail.domain.slice(0, 80) : "a blocked site";
  return `the app ${appLabel(detail.app)}`;
}
