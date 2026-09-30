import type { SignalEvent } from "@neo/verdict";
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
};
