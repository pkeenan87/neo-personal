/**
 * Wire types for the signals routes (_specs/signals.md, docs/contracts.md "HTTP contract:
 * signals"). Dates are ISO-8601.
 */
import type { DetectionLists } from "@neo/tools";

/** Why an event was rejected. */
export type SignalRejectReason = "invalid" | "stale" | "unknown_tool" | "rate_limited" | "relates_to_unknown";

/** One `POST /api/signals` event's outcome, in the same order as the request. */
export interface SignalResult {
  /** null when the event could not even be parsed far enough to recover an id. */
  id: string | null;
  status: "accepted" | "duplicate" | "rejected";
  reason?: SignalRejectReason;
  severity?: "low" | "medium" | "high" | "critical";
  verdictId?: string;
  /** true while an escalation lookup is still running (outcome not yet decided). */
  pending?: boolean;
}

/** POST /api/signals */
export interface SignalIngestResponse {
  results: SignalResult[];
}

/** GET /api/signals/lists */
export type DetectionListsResponse = DetectionLists;

/** One `GET /api/signals/status` result, for one requested client event id. */
export interface SignalStatusResult {
  id: string;
  outcome: "pending" | "alerted" | "recorded" | "dismissed";
  severity?: "low" | "medium" | "high" | "critical";
  verdictId?: string;
  /** true when `alert_id` is set, whatever the outcome (`_specs/browser-extension.md`). */
  alerted: boolean;
}

/** GET /api/signals/status?ids=<uuid>,<uuid> */
export interface SignalStatusResponse {
  results: SignalStatusResult[];
}

/** `POST /api/devices/check-url`'s rating (`_specs/browser-extension.md` "On-demand check"). */
export type UrlRating = "dangerous" | "suspicious" | "no_known_problems" | "unknown";

/** POST /api/devices/check-url */
export interface CheckUrlResponse {
  rating: UrlRating;
  domain: string;
  /** Template sentences, never page text. */
  reasons: string[];
  checkedAt: string;
}

/** An owner's expected remote-access tool for one device (PUT /api/household/devices/[id]/expected-tools). */
export interface ExpectedToolItem {
  toolId: string;
  name: string;
  peerIds: string[];
}

/** PUT /api/household/devices/[id]/expected-tools request body. */
export interface SetExpectedToolsRequest {
  tools: { toolId: string; peerIds: string[] }[];
}

/** PUT /api/household/devices/[id]/expected-tools response. */
export interface SetExpectedToolsResponse {
  tools: ExpectedToolItem[];
}
