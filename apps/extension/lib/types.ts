import type { PolicyEnvelope, SignalEvent } from "@neo/verdict";
import type { DetectionListsPayload } from "@neo/tools/browser";

/** `DeviceItem.kind`/`platform` (`docs/contracts.md` "HTTP contract: devices"). */
export type DeviceKind = "browser_extension";
export type DevicePlatform = "chrome" | "edge" | "firefox";

export interface DeviceInfo {
  kind: DeviceKind;
  platform: DevicePlatform;
  name: string;
  clientVersion: string;
}

/** What the enrolled view shows and what a heartbeat/401 updates. */
export interface HouseholdInfo {
  householdName: string;
  memberName: string | null;
  ownerName: string | null;
}

/** One event waiting to be sent, or already sent and awaiting `/api/signals/status`. */
export interface QueuedEvent {
  event: SignalEvent;
  /** Epoch ms this event was first queued; drives the 23h stale drop. */
  queuedAt: number;
  attempts: number;
  /** The tab the detector reported from, so a later warning can target the same tab. */
  tabId?: number;
  /** The page's full URL at report time (`tech_support_scam`/`lookalike_login` only). */
  originalUrl?: string;
}

export interface PendingPoll {
  id: string;
  /** Epoch ms the event was accepted, so the 90s polling window can be resumed after a restart. */
  startedAt: number;
  nextPollAt: number;
  /** Index into the 2,4,8,16,30s schedule, then every 30s (`_specs/browser-extension.md`). */
  step: number;
  domain: string;
  detector: "lookalike_login";
  brand?: string;
  tabId?: number;
  /** The page's full URL at report time, so "Go back to the page anyway" can return to it exactly. */
  originalUrl: string;
}

/** A warning shown to the person, kept for the popup badge and the 1h bypass suppression. */
export interface WarningRecord {
  id: string;
  domain: string;
  detector: "tech_support_scam" | "lookalike_login";
  brand?: string;
  ownerNotified: boolean;
  shownAt: number;
  tabId?: number;
  originalUrl: string;
}

export type ConnectionState = "unenrolled" | "enrolling" | "enrolled" | "disconnected";

/** An in-progress self sign-in (device-authorization) request, polled until approved or cancelled. */
export interface SignInState {
  deviceCode: string;
  interval: number;
  verificationUri: string;
  userCode: string;
  device: DeviceInfo;
}

/** The last policy bundle that passed signature verification (`_specs/v2-m2-child.md` section 4), as received. */
export interface StoredPolicy {
  envelope: PolicyEnvelope;
  /** The response `ETag`, sent back as `If-None-Match` (except within a day of the bundle's expiry). */
  etag: string | null;
  fetchedAt: number;
}

/** A child request this device opened and has not seen decided; keeps the 60 s policy poll running. */
export interface TrackedRequest {
  id: string;
  domain: string;
  /** ISO time the server stops considering it pending. */
  expiresAt: string;
  /** Answered "approved" but the new bundle had not unblocked the domain yet: keep fetching the bundle on the tick, stop on the page's poll. */
  settled?: boolean;
}

/** The extension's entire persisted state (`storage.local` only, never `storage.sync`). */
export interface ExtensionState {
  connection: ConnectionState;
  serverUrl: string | null;
  token: string | null;
  deviceId: string | null;
  device: DeviceInfo | null;
  household: HouseholdInfo | null;
  lastHeartbeatAt: string | null;
  heartbeatSeconds: number;
  listsVersion: string | null;
  lists: DetectionListsPayload | null;
  listsEtag: string | null;
  listsIsSnapshot: boolean;
  queue: QueuedEvent[];
  /** Epoch ms before which the queue must not be flushed again (exponential backoff). */
  queueNextAttemptAt: number | null;
  queueAttempt: number;
  pending: PendingPoll[];
  /** `${detector}:${domain}` -> epoch ms of the last event sent for it. */
  dedupe: Record<string, number>;
  /** Registrable domain -> epoch ms until warnings are suppressed there (bypass, 1h). */
  suppressUntil: Record<string, number>;
  warnings: WarningRecord[];
  uninstallUrl: string | null;
  signIn: SignInState | null;
  /** Child mode (`_specs/v2-m2-child.md`): the last verified policy bundle; null until one was fetched. */
  policy: StoredPolicy | null;
  /** `policyVersion` the device finished applying (rules installed); reported on the heartbeat. */
  policyApplied: string | null;
  /** Which downloaded category files the matcher uses; null until the lists are in. */
  categoryData: { version: string; shas: Record<string, string> } | null;
  /** Epoch ms at which a running `web.allowOnce` grant ends and the rules must be rebuilt. */
  rulesRebuildAt: number | null;
  trackedRequests: TrackedRequest[];
}

export const DEFAULT_STATE: ExtensionState = {
  connection: "unenrolled",
  serverUrl: null,
  token: null,
  deviceId: null,
  device: null,
  household: null,
  lastHeartbeatAt: null,
  heartbeatSeconds: 3600,
  listsVersion: null,
  lists: null,
  listsEtag: null,
  listsIsSnapshot: true,
  queue: [],
  queueNextAttemptAt: null,
  queueAttempt: 0,
  pending: [],
  dedupe: {},
  suppressUntil: {},
  warnings: [],
  uninstallUrl: null,
  signIn: null,
  policy: null,
  policyApplied: null,
  categoryData: null,
  rulesRebuildAt: null,
  trackedRequests: [],
};
