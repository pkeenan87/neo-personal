/**
 * Deterministic signal rules (_specs/signals.md "Rules"): pure functions of one validated
 * event, the device's expected tools, and a window of the protected member's recent signals
 * (for `warning_bypassed`'s `relatesTo` lookup and scam-in-progress correlation). No I/O, no
 * clock reads beyond what callers pass in. Ambiguous signals fail open: only the clear-cut
 * branches below produce a verdict or an alert; everything else is `recorded` (never attempted
 * a lookup) or `dismissed` (an escalation came back inconclusive).
 *
 * Escalated detectors (`lookalike_login`, `dangerous_site`, `unwanted_software`
 * `unsigned_unknown`) return `outcome: "escalate"`: the caller (lib/server/signals/ingest.ts)
 * stores the row `pending` and hands it to lib/server/signals/escalate.ts, which makes the
 * network calls and then applies its own small, equally deterministic decision (documented
 * there) before raising a verdict/alert the same way this module would have.
 */
import type { ExpectedToolRow, SignalOutcome, SignalSeverity } from "@neo/db";
import { REMOTE_ACCESS_TOOLS, findRemoteAccessTool } from "@neo/tools";
import { isTechSupportScamHit, type SignalDetector, type SignalEvent } from "@neo/verdict";
import type { AlertKindName } from "@/lib/alert-types";

export const SEVERITY_RANK: Record<SignalSeverity, number> = { low: 1, medium: 2, high: 3, critical: 4 };
const RANK_TO_SEVERITY: SignalSeverity[] = ["low", "low", "medium", "high", "critical"]; // index by rank, rank 0 → low

/** Raise a severity one step, capped at `critical`. A never-alerted (`null`) start counts as below `low`. */
export function bumpSeverity(current: SignalSeverity | null): SignalSeverity {
  const rank = current ? SEVERITY_RANK[current] : 0;
  return RANK_TO_SEVERITY[Math.min(4, rank + 1)]!;
}

/** Detector → alert kind for the `page` detectors `warning_bypassed` can relate to. */
const PAGE_ALERT_KIND: Partial<Record<SignalDetector, AlertKindName>> = {
  tech_support_scam: "scam_page",
  lookalike_login: "dangerous_site",
  dangerous_site: "dangerous_site",
  remote_tool_download: "remote_access",
};

/** Alert kind for a stored signal row's detector (used by correlation; `undefined` when the detector never alerts on its own, e.g. an outgoing session). */
export function alertKindForDetector(detector: SignalDetector): AlertKindName | undefined {
  return PAGE_ALERT_KIND[detector] ?? (detector === "remote_access_tool" || detector === "remote_access_session" ? "remote_access" : detector === "unwanted_software" ? "unwanted_software" : undefined);
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
}

export interface RuleContext {
  /** The device's owner-configured expected remote-access tools. */
  expectedTools: readonly ExpectedToolRow[];
  /**
   * The protected member's signals from roughly the last 24h, oldest first, across their
   * devices — for `warning_bypassed`'s `relatesTo` lookup and correlation. Includes events
   * already processed earlier in the same ingest batch (a client sends a bypass right after
   * the event it relates to, in the same batch).
   */
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

const NONE: Pick<RuleOutcome, "severity" | "alertKind" | "verdictLabel"> = { severity: null, alertKind: null, verdictLabel: null };

function recorded(reasonCodes: string[] = []): RuleOutcome {
  return { outcome: "recorded", ...NONE, reasonCodes };
}

/** Evaluate one validated, server-checked event. Never throws. */
export function evaluateEvent(event: SignalEvent, ctx: RuleContext): RuleOutcome {
  switch (event.detector) {
    case "tech_support_scam": {
      const indicators = event.indicators;
      if (isTechSupportScamHit(indicators)) {
        return { outcome: "alerted", severity: "high", alertKind: "scam_page", verdictLabel: "malicious", reasonCodes: [...indicators] };
      }
      return recorded([...indicators]);
    }

    case "lookalike_login":
      return { outcome: "escalate", ...NONE, alertKind: "dangerous_site", reasonCodes: [...event.indicators] };

    case "dangerous_site":
      return { outcome: "escalate", ...NONE, alertKind: "dangerous_site", reasonCodes: ["safe_browsing_prefix"] };

    case "remote_tool_download": {
      const tool = findRemoteAccessTool(event.toolId);
      const vendorDomains = new Set((tool?.vendorDomains ?? []).map((d) => d.toLowerCase()));
      if (!vendorDomains.has(event.domain.toLowerCase())) {
        return { outcome: "alerted", severity: "medium", alertKind: "remote_access", verdictLabel: "suspicious", reasonCodes: ["download_off_vendor_domain"] };
      }
      return recorded(["download_on_vendor_domain"]);
    }

    case "warning_bypassed": {
      const related = ctx.recentUserSignals.find((r) => r.clientEventId === event.relatesTo);
      if (!related) return { outcome: "rejected", ...NONE, rejectReason: "relates_to_unknown", reasonCodes: [] };
      const relatedKind = alertKindForDetector(related.detector) ?? "scam_page";
      return {
        outcome: "alerted",
        severity: bumpSeverity(related.severity),
        alertKind: relatedKind,
        verdictLabel: null,
        bypassOf: { relatesTo: event.relatesTo, relatedVerdictId: related.verdictId, relatedAlertKind: relatedKind },
        reasonCodes: ["warning_bypassed"],
      };
    }

    case "remote_access_tool": {
      const expected = ctx.expectedTools.some((t) => t.toolId === event.toolId);
      return {
        outcome: "alerted",
        severity: expected ? "low" : "high",
        alertKind: "remote_access",
        verdictLabel: "suspicious",
        reasonCodes: expected ? ["expected_remote_tool"] : ["unexpected_remote_tool"],
      };
    }

    case "unwanted_software": {
      if (event.reason === "unsigned_unknown") {
        if (!event.sha256) return recorded(["unsigned_unknown_no_hash"]);
        return { outcome: "escalate", ...NONE, alertKind: "unwanted_software", reasonCodes: ["unsigned_unknown"] };
      }
      return { outcome: "alerted", severity: "medium", alertKind: "unwanted_software", verdictLabel: "suspicious", reasonCodes: [event.reason] };
    }

    case "remote_access_session": {
      if (event.direction === "outgoing") return recorded(["outgoing_session"]);
      const expectedTool = ctx.expectedTools.find((t) => t.toolId === event.toolId);
      const peerKnown = Boolean(expectedTool && event.peerId && expectedTool.peerIds.includes(event.peerId));
      const severity: SignalSeverity = expectedTool ? (peerKnown ? "low" : "high") : "critical";
      return {
        outcome: "alerted",
        severity,
        alertKind: "remote_access",
        verdictLabel: "malicious",
        reasonCodes: [expectedTool ? (peerKnown ? "expected_peer" : "unexpected_peer") : "unexpected_remote_session"],
      };
    }

    case "tcc_grant": {
      const tool = matchRemoteAccessToolByBundleId(event.bundleId);
      if (tool) {
        const expected = ctx.expectedTools.some((t) => t.toolId === tool.id);
        return {
          outcome: "alerted",
          severity: expected ? "low" : "critical",
          alertKind: "remote_access",
          verdictLabel: "malicious",
          reasonCodes: [expected ? "expected_remote_tool_permission" : "unexpected_remote_tool_permission"],
        };
      }
      if (event.service === "screen_recording" || event.service === "accessibility") {
        return { outcome: "alerted", severity: "medium", alertKind: "permission_grant", verdictLabel: "suspicious", reasonCodes: [event.service] };
      }
      return recorded([event.service]);
    }

    default: {
      const _exhaustive: never = event;
      return recorded([(_exhaustive as SignalEvent).detector]);
    }
  }
}

function matchRemoteAccessToolByBundleId(bundleId: string | undefined) {
  if (!bundleId) return undefined;
  const needle = bundleId.toLowerCase();
  return REMOTE_ACCESS_TOOLS.find((t) => t.macos.bundleIds.some((b) => b.toLowerCase() === needle));
}

// ─── Correlation (_specs/signals.md "Correlation") ─────────────────

export const CORRELATION_WINDOW_MS = 30 * 60 * 1000;
const SCAM_KINDS: readonly AlertKindName[] = ["scam_page", "dangerous_site"];
const SCAM_SEVERITIES: readonly SignalSeverity[] = ["high", "critical"];

export interface CorrelationEvent {
  id: string;
  deviceId: string;
  kind: AlertKindName;
  severity: SignalSeverity;
  observedAt: Date;
}

export interface CorrelationResult {
  events: CorrelationEvent[];
  /** UTC-floored 30-minute bucket of the earlier event, for the dedupe key. */
  bucket: string;
}

/** Floor to a 30-minute UTC boundary, formatted `YYYY-MM-DDTHH:MM` (stable dedupe bucket). */
export function thirtyMinuteBucket(d: Date): string {
  const stepMs = CORRELATION_WINDOW_MS;
  const floored = new Date(Math.floor(d.getTime() / stepMs) * stepMs);
  return floored.toISOString().slice(0, 16);
}

/**
 * A scam page/dangerous site (high+) and any remote-access event within 30 minutes of each
 * other, in either order, anywhere in `events` (already scoped to one member, any of their
 * devices). Returns the earliest matching pair, oldest first.
 */
export function findScamInProgress(events: readonly CorrelationEvent[]): CorrelationResult | null {
  const scams = events.filter((e) => SCAM_KINDS.includes(e.kind) && SCAM_SEVERITIES.includes(e.severity));
  const remotes = events.filter((e) => e.kind === "remote_access");
  let best: [CorrelationEvent, CorrelationEvent] | null = null;
  for (const s of scams) {
    for (const r of remotes) {
      const dt = Math.abs(s.observedAt.getTime() - r.observedAt.getTime());
      if (dt > CORRELATION_WINDOW_MS) continue;
      if (!best || Math.min(s.observedAt.getTime(), r.observedAt.getTime()) < Math.min(best[0].observedAt.getTime(), best[1].observedAt.getTime())) {
        best = [s, r];
      }
    }
  }
  if (!best) return null;
  const pair = [...best].sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
  return { events: pair, bucket: thirtyMinuteBucket(pair[0]!.observedAt) };
}
