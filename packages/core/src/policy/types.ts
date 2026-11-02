import type { ProtectionDisabledReason, Severity, SignalEvent, ServerSignalEvent } from "@neo/verdict";

/** Alert kinds the engine can produce (a superset of today's `AlertKindName` signal kinds). */
export type EngineAlertKind =
  | "scam_page"
  | "dangerous_site"
  | "remote_access"
  | "unwanted_software"
  | "permission_grant"
  | "install_during_session"
  | "payment_under_pressure"
  | "protection_disabled"
  | "self_harm_attempts"
  | "app_approval";

export type CorrelationKind = "scam_in_progress" | "install_during_session" | "payment_under_pressure";
export type DecisionAction = "record" | "dismiss" | "incident" | "escalate" | "reject";
export type VerdictLabel = "malicious" | "suspicious";

/** Stored-row outcomes, as in `device_signals.outcome`. */
export type StoredOutcome = "pending" | "alerted" | "recorded" | "dismissed" | "rejected";

/** A previously stored signal of the same member (any of their devices), oldest first. */
export interface RecentSignal {
  id: string;
  clientEventId: string;
  detector: string;
  severity: Severity | null;
  outcome: StoredOutcome;
  verdictId: string | null;
  observedAt: Date;
  deviceId: string;
  /** The stored event minus id/type/detector (`device_signals.payload`); read for `discovery` and `direction`. */
  payload?: Record<string, unknown>;
}

/** Remote-access catalog facts, injected so core need not depend on `@neo/tools`. */
export interface EngineCatalog {
  vendorDomains(toolId: string): string[];
  toolIdForBundle(bundleId: string): string | undefined;
}

export interface ExpectedToolRef {
  toolId: string;
  peerIds: readonly string[];
}

export interface EvaluationContext {
  /** Evaluation time (the signal's `receivedAt`); the engine never reads a clock. */
  now: Date;
  /** The device the signal came from; used when the current signal joins a correlation. */
  deviceId: string;
  /** The device's owner-configured expected remote-access tools. */
  expectedTools: readonly ExpectedToolRef[];
  /** The member's signals from roughly the last 24h across their devices. May include the current signal's own row (matched by `clientEventId`). */
  recent: readonly RecentSignal[];
  catalog: EngineCatalog;
}

/** Result of a reputation lookup for an escalated signal (`signal-escalate`). */
export interface Enrichment {
  label: "malicious" | "suspicious" | "clean" | "failed";
  /** Overrides the default severity of a confirmed label. */
  severity?: Severity;
  /** Overrides the default reason codes of a confirmed label. */
  reasonCodes?: string[];
}

export interface EvaluationInput {
  event: SignalEvent | ServerSignalEvent;
  /** Stored row id of this signal, used in `Correlation.signalIds` (falls back to the client event id). */
  signalId?: string;
  enrichment?: Enrichment;
}

export interface CorrelationMember {
  id: string;
  deviceId: string;
  kind: EngineAlertKind;
  severity: Severity;
  observedAt: Date;
}

export interface Correlation {
  kind: CorrelationKind;
  severity: Severity;
  /** UTC-floored 30-minute bucket of the earliest event; dedupe key is `<kind>:<userId>:<bucket>`. */
  bucket: string;
  /** Row ids of the events involved, oldest first. */
  signalIds: string[];
  /** The same events with kind/time, oldest first (for alert text). */
  events: CorrelationMember[];
  notifyNow: boolean;
}

export interface Decision {
  action: DecisionAction;
  /** Alert kind for `incident` and `escalate` (the kind a confirmed escalation would raise); `null` otherwise. */
  kind: EngineAlertKind | null;
  severity: Severity | null;
  verdictLabel: VerdictLabel | null;
  /** Indicator/evidence codes for the verdict and alert. */
  reasonCodes: string[];
  /** Set only when `action === "reject"`. */
  rejectReason?: "relates_to_unknown";
  /** Set only for `warning_bypassed`. */
  bypassOf?: { relatesTo: string; relatedVerdictId: string | null; relatedAlertKind: EngineAlertKind | null };
  /**
   * True when an `incident` meets `min(notify.ownersNotifyAt, notify.helpersNotifyAt)` (unset
   * thresholds are ignored; both unset means `high`). Per-owner `alert_email_threshold` and
   * the helper threshold still filter recipients downstream.
   */
  notifyNow: boolean;
  /** Mirrors `action === "escalate"`: queue enrichment. */
  escalate: boolean;
  /** Correlated incidents this signal completes; the caller raises one alert each. Empty unless `action === "incident"`. */
  correlations: Correlation[];
}

export type { ProtectionDisabledReason };
