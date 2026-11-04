/**
 * Policy engine (_specs/v2-m1-elder.md §4): a pure function of one signal, the effective policy,
 * the device's expected tools and the member's recent signals. No I/O, no clock (`ctx.now` is
 * passed in), no model. Absorbs the former `apps/web/lib/server/signals/rules.ts` rules and the
 * correlation glue in `apply.ts`/`escalate.ts`; with `standard` defaults the action, severity,
 * kind, verdict label, reason codes and bypass info match those exactly.
 *
 * Ambiguous signals fail open: only clear-cut branches raise an incident; everything else is
 * `record` (never looked up) or `dismiss` (an escalation came back inconclusive).
 */
import { isTechSupportScamHit, type PolicyRules, type ServerSignalEvent, type Severity, type SignalEvent } from "@neo/verdict";
import { SEVERITY_RANK, bumpSeverity, findScamInProgress, isScamEvent, thirtyMinuteBucket } from "./severity.js";
import type {
  Correlation,
  CorrelationMember,
  Decision,
  DecisionAction,
  EngineAlertKind,
  Enrichment,
  EvaluationContext,
  EvaluationInput,
  RecentSignal,
  VerdictLabel,
} from "./types.js";

const SCAM_LOOKBACK_MS = 60 * 60 * 1000; // wider than the 30-minute correlation window, so a pair straddling it is still found
const DEFAULT_NOTIFY_AT: Severity = "high";
/** Child mode: this many `self_harm` blocks within the window, across the member's devices, is an incident (_specs/v2-m2-child.md section 3). */
const SELF_HARM_THRESHOLD = 3;
const SELF_HARM_WINDOW_MS = 60 * 60 * 1000;

interface Base {
  action: DecisionAction;
  kind: EngineAlertKind | null;
  severity: Severity | null;
  verdictLabel: VerdictLabel | null;
  reasonCodes: string[];
  rejectReason?: "relates_to_unknown";
  bypassOf?: Decision["bypassOf"];
  /** Set when the incident must notify whatever the notify thresholds say. */
  notifyAlways?: boolean;
}

const NONE = { kind: null, severity: null, verdictLabel: null } as const;

function record(reasonCodes: string[] = []): Base {
  return { action: "record", ...NONE, reasonCodes };
}

function incident(kind: EngineAlertKind, severity: Severity, verdictLabel: VerdictLabel | null, reasonCodes: string[]): Base {
  return { action: "incident", kind, severity, verdictLabel, reasonCodes };
}

/** Detector → alert kind for the detectors `warning_bypassed` can relate to (and the other single-event kinds). */
export function alertKindForDetector(detector: string): EngineAlertKind | undefined {
  switch (detector) {
    case "tech_support_scam":
      return "scam_page";
    case "lookalike_login":
    case "dangerous_site":
      return "dangerous_site";
    case "remote_tool_download":
    case "remote_access_tool":
    case "remote_access_session":
      return "remote_access";
    case "unwanted_software":
      return "unwanted_software";
    default:
      return undefined;
  }
}

/** Detector → kind for scam-in-progress correlation. `unwanted_software` never joins it. */
function correlationKind(detector: string): EngineAlertKind | undefined {
  const kind = alertKindForDetector(detector);
  return kind === "unwanted_software" ? undefined : kind;
}

/** A trigger session is an unknown-peer / unexpected-tool one (high or critical); an expected helper's own session (low) never pages. */
function isNonBaselineIncomingSession(r: RecentSignal): boolean {
  return r.detector === "remote_access_session" && r.outcome === "alerted" && r.severity !== null && SEVERITY_RANK[r.severity] >= SEVERITY_RANK.high && r.payload?.direction === "incoming" && r.payload?.discovery !== "baseline";
}

function evaluateServerSignal(policy: PolicyRules, event: ServerSignalEvent): Base {
  const severity = policy.devices?.protectionDisabledSeverity;
  if (!severity) return record(["protection_disabled", event.reason]);
  return incident("protection_disabled", severity, null, [event.reason]);
}

/**
 * True when the current `self_harm` web block completes a run of `SELF_HARM_THRESHOLD` blocks that fit
 * in `SELF_HARM_WINDOW_MS` (edges inclusive), counting the member's earlier blocks on any device and
 * the current one. A run is a window of consecutive blocks in time order that includes the current one,
 * so a late-arriving older event is judged the same way as a fresh one.
 */
function completesSelfHarmRun(event: Extract<SignalEvent, { detector: "web_blocked" }>, ctx: EvaluationContext): boolean {
  if (event.category !== "self_harm") return false;
  const at = new Date(event.observedAt).getTime();
  const times = ctx.recent.filter((r) => r.detector === "web_blocked" && r.clientEventId !== event.id && r.payload?.category === "self_harm").map((r) => r.observedAt.getTime());
  times.push(at);
  times.sort((a, b) => a - b);
  const self = times.indexOf(at);
  for (let start = Math.max(0, self - (SELF_HARM_THRESHOLD - 1)); start <= self && start + SELF_HARM_THRESHOLD <= times.length; start++) {
    if (times[start + SELF_HARM_THRESHOLD - 1]! - times[start]! <= SELF_HARM_WINDOW_MS) return true;
  }
  return false;
}

function evaluateEvent(policy: PolicyRules, event: SignalEvent, ctx: EvaluationContext): Base {
  switch (event.detector) {
    case "tech_support_scam": {
      const indicators = event.indicators;
      if (isTechSupportScamHit(indicators)) return incident("scam_page", "high", "malicious", [...indicators]);
      return record([...indicators]);
    }

    case "lookalike_login":
      return { action: "escalate", ...NONE, kind: "dangerous_site", reasonCodes: [...event.indicators] };

    case "dangerous_site":
      return { action: "escalate", ...NONE, kind: "dangerous_site", reasonCodes: ["safe_browsing_prefix"] };

    case "remote_tool_download": {
      const vendorDomains = new Set(ctx.catalog.vendorDomains(event.toolId).map((d) => d.toLowerCase()));
      if (!vendorDomains.has(event.domain.toLowerCase())) return incident("remote_access", "medium", "suspicious", ["download_off_vendor_domain"]);
      return record(["download_on_vendor_domain"]);
    }

    case "warning_bypassed": {
      const related = ctx.recent.find((r) => r.clientEventId === event.relatesTo);
      if (!related) return { action: "reject", ...NONE, rejectReason: "relates_to_unknown", reasonCodes: [] };
      const relatedKind = alertKindForDetector(related.detector) ?? "scam_page";
      return {
        action: "incident",
        kind: relatedKind,
        severity: bumpSeverity(related.severity),
        verdictLabel: null,
        bypassOf: { relatesTo: event.relatesTo, relatedVerdictId: related.verdictId, relatedAlertKind: relatedKind },
        reasonCodes: ["warning_bypassed"],
      };
    }

    case "remote_access_tool": {
      const expected = ctx.expectedTools.some((t) => t.toolId === event.toolId);
      if (event.discovery === "baseline") {
        // Already installed when the desktop agent enrolled: surface it so the owner can mark it expected, but not as a fresh install.
        return incident("remote_access", expected ? "low" : "medium", "suspicious", [expected ? "expected_remote_tool" : "baseline_remote_tool"]);
      }
      return incident("remote_access", expected ? "low" : "high", "suspicious", [expected ? "expected_remote_tool" : "unexpected_remote_tool"]);
    }

    case "unwanted_software": {
      if (event.reason === "unsigned_unknown") {
        if (!event.sha256) return record(["unsigned_unknown_no_hash"]);
        return { action: "escalate", ...NONE, kind: "unwanted_software", reasonCodes: ["unsigned_unknown"] };
      }
      return incident("unwanted_software", "medium", "suspicious", [event.reason]);
    }

    case "remote_access_session": {
      if (event.direction === "outgoing") return record(["outgoing_session"]);
      const expectedTool = ctx.expectedTools.find((t) => t.toolId === event.toolId);
      const peerKnown = Boolean(expectedTool && event.peerId && expectedTool.peerIds.includes(event.peerId));
      const severity: Severity = expectedTool ? (peerKnown ? "low" : (policy.remote_access?.unknownPeerSeverity ?? "high")) : "critical";
      return incident("remote_access", severity, "malicious", [expectedTool ? (peerKnown ? "expected_peer" : "unexpected_peer") : "unexpected_remote_session"]);
    }

    case "tcc_grant": {
      const toolId = event.bundleId ? ctx.catalog.toolIdForBundle(event.bundleId) : undefined;
      if (toolId) {
        const expected = ctx.expectedTools.some((t) => t.toolId === toolId);
        return incident("remote_access", expected ? "low" : "critical", "malicious", [expected ? "expected_remote_tool_permission" : "unexpected_remote_tool_permission"]);
      }
      if (event.service === "screen_recording" || event.service === "accessibility") return incident("permission_grant", "medium", "suspicious", [event.service]);
      return record([event.service]);
    }

    case "payment_page": {
      // Rule is off (record only) unless the policy configures an under-pressure window.
      if (policy.payments?.underPressureWindowMinutes === undefined) return record(["payment_page", event.category]);
      return incident("payment_under_pressure", "medium", "suspicious", ["payment_page", event.category]);
    }

    // ---- Child mode (_specs/v2-m2-child.md section 3). Each rule is gated by what the policy configures, so Standard (no web/apps section, no tamper severity) only records.
    case "web_blocked": {
      // Only a policy with a web section blocks sites, so only it watches for repeated self-harm searches.
      if (policy.web !== undefined && completesSelfHarmRun(event, ctx)) return incident("self_harm_attempts", "high", null, ["self_harm_blocks"]);
      return record(["web_blocked", event.category]);
    }

    case "app_installed": {
      if (policy.apps?.requireApproval) return { ...incident("app_approval", "medium", null, ["app_needs_approval"]), notifyAlways: true };
      return record(["app_installed"]);
    }

    case "app_blocked":
      return record(["app_blocked"]);

    case "screen_time_exhausted":
      return record(["screen_time_exhausted"]);

    // A device's answer to a server command: the ingest handles it before the engine; recorded only if it ever gets here.
    case "command_result":
      return record(["command_result"]);

    case "tamper_detected": {
      // Same switch as the server's protection_disabled: Child and Elder defaults set it, Standard leaves it off.
      const severity = policy.devices?.protectionDisabledSeverity;
      if (!severity) return record(["tamper_detected", event.reason]);
      return incident("protection_disabled", severity, null, ["tamper_detected", event.reason]);
    }

    default: {
      const _exhaustive: never = event;
      return record([(_exhaustive as SignalEvent).detector]);
    }
  }
}

/** The decision after a reputation lookup (`signal-escalate`): `failed` and `clean` always dismiss and never alert. */
function evaluateEnrichment(event: SignalEvent | ServerSignalEvent, e: Enrichment): Base {
  const dismiss: Base = { action: "dismiss", ...NONE, reasonCodes: [] };
  if (e.label === "failed" || e.label === "clean") return dismiss;
  switch (event.detector) {
    case "lookalike_login":
      if (e.label === "malicious") return incident("dangerous_site", e.severity ?? "high", "malicious", e.reasonCodes ?? ["brand_lookalike"]);
      return incident("dangerous_site", e.severity ?? "medium", "suspicious", e.reasonCodes ?? ["brand_lookalike"]);
    case "dangerous_site":
      if (e.label !== "malicious") return dismiss;
      return incident("dangerous_site", e.severity ?? "high", "malicious", e.reasonCodes ?? ["safe_browsing_prefix", "safe_browsing_match"]);
    case "unwanted_software":
      if (e.label !== "malicious" || event.reason !== "unsigned_unknown" || !event.sha256) return dismiss;
      return incident("unwanted_software", e.severity ?? "high", "malicious", e.reasonCodes ?? ["unsigned_unknown", "virustotal_malicious"]);
    default:
      return dismiss; // not an escalating detector (defensive)
  }
}

function notifyThreshold(policy: PolicyRules): Severity {
  const levels = [policy.notify?.ownersNotifyAt, policy.notify?.helpersNotifyAt].filter((s): s is Severity => s !== undefined);
  if (levels.length === 0) return DEFAULT_NOTIFY_AT;
  return levels.reduce((a, b) => (SEVERITY_RANK[a] <= SEVERITY_RANK[b] ? a : b));
}

function meetsNotify(policy: PolicyRules, severity: Severity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[notifyThreshold(policy)];
}

function correlation(policy: PolicyRules, kind: Correlation["kind"], events: CorrelationMember[]): Correlation {
  const sorted = [...events].sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
  return { kind, severity: "critical", bucket: thirtyMinuteBucket(sorted[0]!.observedAt), signalIds: sorted.map((e) => e.id), events: sorted, notifyNow: meetsNotify(policy, "critical") };
}

function computeCorrelations(policy: PolicyRules, event: SignalEvent, base: Base, input: EvaluationInput, ctx: EvaluationContext): Correlation[] {
  const out: Correlation[] = [];
  const observedAt = new Date(event.observedAt);
  const self: CorrelationMember = { id: input.signalId ?? event.id, deviceId: ctx.deviceId, kind: base.kind!, severity: base.severity!, observedAt };
  const others = ctx.recent.filter((r) => r.clientEventId !== event.id && r.outcome === "alerted");

  // scam_in_progress: re-checked after every incident, as apply.ts does; the dedupe key makes repeats no-ops.
  const since = ctx.now.getTime() - SCAM_LOOKBACK_MS;
  const members: CorrelationMember[] = [];
  for (const r of others) {
    const kind = correlationKind(r.detector);
    if (!kind || !r.severity || r.observedAt.getTime() < since) continue;
    // A tool already installed at enrollment is not evidence of a call happening now.
    if (r.detector === "remote_access_tool" && r.payload?.discovery === "baseline") continue;
    members.push({ id: r.id, deviceId: r.deviceId, kind, severity: r.severity, observedAt: r.observedAt });
  }
  const selfKind = correlationKind(event.detector);
  if (selfKind && !(event.detector === "remote_access_tool" && event.discovery === "baseline")) members.push({ ...self, kind: selfKind });
  const scam = findScamInProgress(members);
  if (scam) {
    out.push({ kind: "scam_in_progress", severity: "critical", bucket: scam.bucket, signalIds: scam.events.map((e) => e.id), events: scam.events, notifyNow: meetsNotify(policy, "critical") });
  }

  // install_during_session: an alerting install/permission after a (non-baseline) incoming session.
  const sessionWindow = policy.remote_access?.sessionWindowMinutes;
  if (sessionWindow !== undefined && (event.detector === "unwanted_software" || event.detector === "tcc_grant") && SEVERITY_RANK[base.severity!] >= SEVERITY_RANK.medium) {
    const session = latestBefore(others.filter(isNonBaselineIncomingSession), observedAt, sessionWindow);
    if (session) out.push(correlation(policy, "install_during_session", [toMember(session, "remote_access"), self]));
  }

  // payment_under_pressure: a payment page after a high+ scam page or an incoming session.
  const payWindow = policy.payments?.underPressureWindowMinutes;
  if (payWindow !== undefined && event.detector === "payment_page") {
    const triggers = others.filter((r) => isNonBaselineIncomingSession(r) || isScamRow(r));
    const trigger = latestBefore(triggers, observedAt, payWindow);
    if (trigger) out.push(correlation(policy, "payment_under_pressure", [toMember(trigger, isScamRow(trigger) ? (correlationKind(trigger.detector) as EngineAlertKind) : "remote_access"), self]));
  }
  return out;
}

function isScamRow(r: RecentSignal): boolean {
  const kind = correlationKind(r.detector);
  return Boolean(kind && r.severity && isScamEvent({ kind, severity: r.severity }));
}

function toMember(r: RecentSignal, kind: EngineAlertKind): CorrelationMember {
  return { id: r.id, deviceId: r.deviceId, kind, severity: r.severity ?? "low", observedAt: r.observedAt };
}

/** The latest row at or before `at`, no more than `windowMinutes` earlier (edges inclusive). */
function latestBefore(rows: readonly RecentSignal[], at: Date, windowMinutes: number): RecentSignal | undefined {
  const windowMs = windowMinutes * 60_000;
  let best: RecentSignal | undefined;
  for (const r of rows) {
    const dt = at.getTime() - r.observedAt.getTime();
    if (dt < 0 || dt > windowMs) continue;
    if (!best || r.observedAt.getTime() > best.observedAt.getTime()) best = r;
  }
  return best;
}

/** Evaluate one validated signal under `policy`. Never throws; pure. */
export function evaluateSignal(policy: PolicyRules, input: EvaluationInput, ctx: EvaluationContext): Decision {
  const { event } = input;
  const isServer = event.detector === "protection_disabled";
  let base: Base;
  if (input.enrichment) base = evaluateEnrichment(event, input.enrichment);
  else if (isServer) base = evaluateServerSignal(policy, event as ServerSignalEvent);
  else base = evaluateEvent(policy, event as SignalEvent, ctx);

  const { notifyAlways, ...decided } = base;
  const incidentNow = decided.action === "incident";
  return {
    ...decided,
    notifyNow: incidentNow && (notifyAlways === true || meetsNotify(policy, decided.severity!)),
    escalate: base.action === "escalate",
    correlations: incidentNow && !isServer ? computeCorrelations(policy, event as SignalEvent, base, input, ctx) : [],
  };
}
