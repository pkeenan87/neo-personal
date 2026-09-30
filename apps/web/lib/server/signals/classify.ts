/**
 * classifyUrlAnalysis(analysis) → { rating, reasons } (_specs/browser-extension.md "Server
 * changes"): the deterministic mapping shared by the lookalike-login escalation (escalate.ts)
 * and the on-demand check route (POST /api/devices/check-url). `reasons` are fixed template
 * sentences, never page text or attacker-controlled strings — the analyzed page's own words
 * never reach this function's output.
 *
 * - dangerous: Google Safe Browsing flags it, urlscan.io calls it malicious, or 3+ VirusTotal
 *   engines flag it malicious.
 * - suspicious: a brand lookalike, a domain registered less than 30 days ago, or 1-2
 *   VirusTotal engines flag it malicious.
 * - unknown: every reputation source was skipped or errored, and neither of the above fired.
 * - else: no_known_problems.
 */
import { isSkipped, type UrlAnalysis } from "@neo/tools";
import type { UrlRating } from "@/lib/signal-types";

export interface UrlClassification {
  rating: UrlRating;
  reasons: string[];
}

function vtMaliciousCount(analysis: UrlAnalysis): number {
  const vt = analysis.reputation.virustotal;
  return vt && !isSkipped(vt) && vt.status === "found" ? vt.malicious : 0;
}

export function classifyUrlAnalysis(analysis: UrlAnalysis): UrlClassification {
  const sb = analysis.reputation.safe_browsing;
  const us = analysis.reputation.urlscan;
  const sbFlagged = Boolean(sb && !isSkipped(sb) && sb.flagged);
  const usMalicious = Boolean(us && !isSkipped(us) && us.malicious === true);
  const vtMalicious = vtMaliciousCount(analysis);

  if (sbFlagged || usMalicious || vtMalicious >= 3) {
    const reasons: string[] = [];
    if (sbFlagged) reasons.push("Google Safe Browsing has flagged this site.");
    if (usMalicious) reasons.push("urlscan.io's verdict for this site is malicious.");
    if (vtMalicious >= 3) reasons.push(`${vtMalicious} security vendors flag this site as malicious.`);
    return { rating: "dangerous", reasons };
  }

  const lookalike = analysis.lookalike ?? null;
  const isYoung = analysis.heuristics.includes("young_domain");
  if (lookalike || isYoung || vtMalicious >= 1) {
    const reasons: string[] = [];
    if (lookalike) reasons.push(`This domain looks like it is imitating ${lookalike.brand}.`);
    if (isYoung) reasons.push("This domain was registered less than 30 days ago.");
    if (vtMalicious >= 1) reasons.push(`${vtMalicious} security vendor${vtMalicious === 1 ? "" : "s"} flag${vtMalicious === 1 ? "s" : ""} this site as malicious.`);
    return { rating: "suspicious", reasons };
  }

  const vt = analysis.reputation.virustotal;
  const allSkippedOrErrored = (!sb || isSkipped(sb)) && (!vt || isSkipped(vt)) && (!us || isSkipped(us));
  if (allSkippedOrErrored) {
    return { rating: "unknown", reasons: ["Neo could not check this site's reputation right now."] };
  }

  return { rating: "no_known_problems", reasons: [] };
}
