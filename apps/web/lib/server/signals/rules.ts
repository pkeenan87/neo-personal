/**
 * Deterministic signal rules (_specs/signals.md "Rules"). The rules now live in the @neo/core
 * policy engine (`evaluateSignal`, _specs/v2-m1-elder.md §4); this module is a thin adapter that
 * keeps the original `evaluateEvent` shape (evaluated under Standard defaults) and re-exports
 * the shared severity and correlation helpers. The ingest and escalation paths call
 * `evaluateSignal` directly with the member's effective policy.
 */
import type { ExpectedToolRow, SignalOutcome, SignalSeverity } from "@neo/db";
import {
  CORRELATION_WINDOW_MS,
  SEVERITY_RANK,
  alertKindForDetector as coreAlertKindForDetector,
  bumpSeverity,
  effectivePolicy,
  evaluateSignal,
  findScamInProgress,
  thirtyMinuteBucket,
  type CorrelationMember,
  type DecisionAction,
  type EngineCatalog,
  type ScamInProgress,
} from "@neo/core";
import { REMOTE_ACCESS_TOOLS, findRemoteAccessTool } from "@neo/tools";
import type { SignalDetector, SignalEvent } from "@neo/verdict";
import type { AlertKindName } from "@/lib/alert-types";

export { CORRELATION_WINDOW_MS, SEVERITY_RANK, bumpSeverity, findScamInProgress, thirtyMinuteBucket };

export type CorrelationEvent = CorrelationMember;
export type CorrelationResult = ScamInProgress;

/** Remote-access catalog facts for the engine, from @neo/tools. */
export const ENGINE_CATALOG: EngineCatalog = {
  vendorDomains: (toolId) => findRemoteAccessTool(toolId)?.vendorDomains ?? [],
  toolIdForBundle: (bundleId) => {
    const needle = bundleId.toLowerCase();
    return REMOTE_ACCESS_TOOLS.find((t) => t.macos.bundleIds.some((b) => b.toLowerCase() === needle))?.id;
  },
};

/** Alert kind for a stored signal row's detector (`undefined` when the detector never alerts on its own, e.g. an outgoing session). */
export function alertKindForDetector(detector: SignalDetector): AlertKindName | undefined {
  return coreAlertKindForDetector(detector) as AlertKindName | undefined;
}

/** Minimal shape of a previously stored signal, for `relatesTo` lookup and correlation. */
export interface RuleSignalRef {
  id: string;
  clientEventId: string;
  detector: SignalDetector;
  severity: SignalSeverity | null;
  outcome: SignalOutcome;
  verdictId: string | null;
  observedAt: Date;
  deviceId: string;
  payload?: Record<string, unknown>;
}

export interface RuleContext {
  /** The device's owner-configured expected remote-access tools. */
  expectedTools: readonly ExpectedToolRow[];
  /** The protected member's signals from roughly the last 24h, oldest first, across their devices. */
  recentUserSignals: readonly RuleSignalRef[];
  /** Present only for lifecycle decisions (offline/removed alerts); signal rules ignore it. */
  isOwnerDevice: boolean;
}

export type RuleVerdictLabel = "malicious" | "suspicious";

export interface RuleOutcome {
  outcome: "alerted" | "recorded" | "dismissed" | "escalate" | "rejected";
  severity: SignalSeverity | null;
  alertKind: AlertKindName | null;
  verdictLabel: RuleVerdictLabel | null;
  /** Set only when `outcome === "rejected"`. */
  rejectReason?: "relates_to_unknown";
  /** Set only for `warning_bypassed`: the related row this bump/alert refers to. */
  bypassOf?: { relatesTo: string; relatedVerdictId: string | null; relatedAlertKind: AlertKindName | null };
  /** Indicator/evidence codes used to build the verdict (lib/server/signals/verdicts.ts). */
  reasonCodes: string[];
}

const OUTCOME: Record<DecisionAction, RuleOutcome["outcome"]> = { incident: "alerted", record: "recorded", dismiss: "dismissed", escalate: "escalate", reject: "rejected" };
const STANDARD = effectivePolicy({ mode: "standard" });

/** Evaluate one validated, server-checked event under Standard defaults. Never throws. */
export function evaluateEvent(event: SignalEvent, ctx: RuleContext): RuleOutcome {
  const d = evaluateSignal(
    STANDARD,
    { event },
    { now: new Date(event.observedAt), deviceId: "", expectedTools: ctx.expectedTools, recent: ctx.recentUserSignals.map((r) => ({ ...r })), catalog: ENGINE_CATALOG },
  );
  return {
    outcome: OUTCOME[d.action],
    severity: d.severity,
    alertKind: d.kind as AlertKindName | null,
    verdictLabel: d.verdictLabel,
    ...(d.rejectReason ? { rejectReason: d.rejectReason } : {}),
    ...(d.bypassOf ? { bypassOf: d.bypassOf as RuleOutcome["bypassOf"] } : {}),
    reasonCodes: d.reasonCodes,
  };
}
