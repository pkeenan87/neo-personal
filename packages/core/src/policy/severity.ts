import type { Severity } from "@neo/verdict";
import type { CorrelationMember, EngineAlertKind } from "./types.js";

export const SEVERITY_RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3, critical: 4 };
const RANK_TO_SEVERITY: Severity[] = ["low", "low", "medium", "high", "critical"]; // index by rank, rank 0 → low

/** Raise a severity one step, capped at `critical`. A never-alerted (`null`) start counts as below `low`. */
export function bumpSeverity(current: Severity | null): Severity {
  const rank = current ? SEVERITY_RANK[current] : 0;
  return RANK_TO_SEVERITY[Math.min(4, rank + 1)]!;
}

export const CORRELATION_WINDOW_MS = 30 * 60 * 1000;

/** Floor to a 30-minute UTC boundary, formatted `YYYY-MM-DDTHH:MM` (stable dedupe bucket). */
export function thirtyMinuteBucket(d: Date): string {
  const floored = new Date(Math.floor(d.getTime() / CORRELATION_WINDOW_MS) * CORRELATION_WINDOW_MS);
  return floored.toISOString().slice(0, 16);
}

const SCAM_KINDS: readonly EngineAlertKind[] = ["scam_page", "dangerous_site"];
const SCAM_SEVERITIES: readonly Severity[] = ["high", "critical"];

/** A scam page / dangerous site at high or critical severity. */
export function isScamEvent(e: Pick<CorrelationMember, "kind" | "severity">): boolean {
  return SCAM_KINDS.includes(e.kind) && SCAM_SEVERITIES.includes(e.severity);
}

export interface ScamInProgress {
  events: CorrelationMember[];
  bucket: string;
}

/**
 * A scam page/dangerous site (high+) and any remote-access event within 30 minutes of each
 * other, in either order, anywhere in `events` (already scoped to one member, any of their
 * devices). Returns the earliest matching pair, oldest first.
 */
export function findScamInProgress(events: readonly CorrelationMember[]): ScamInProgress | null {
  const scams = events.filter(isScamEvent);
  const remotes = events.filter((e) => e.kind === "remote_access");
  let best: [CorrelationMember, CorrelationMember] | null = null;
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
