import { verdictSeverityRank, type VerdictLabel, type Severity } from "@neo/verdict";
import { cleanText, truncate } from "../email/verdict-email";
export type PersonalDigestSlot = { verdictCounts: Array<{ label: VerdictLabel; count: number }>; topVerdicts: Array<{ id: string; label: VerdictLabel; headline: string; createdAt: string; href: string }> };
export type HouseholdDigestSlot = { alertCounts: Array<{ severity: Severity; count: number }>; topAlerts: Array<{ label: string; severity: Severity; createdAt: string; href: string }>; devices: { offline: number; removedOrUninstalled: number } };
/** Optional slots reserved for later roadmap steps; no source or renderer is implemented. */
export type BreachStatusSlot = { status: "clean" | "breached" | "not_checked"; href: string };
export type HardeningScoreSlot = { scorePercent: number | null; href: string };
export interface DigestRendererSlots { personal?: PersonalDigestSlot; household?: HouseholdDigestSlot; breachStatus?: BreachStatusSlot; hardeningScore?: HardeningScoreSlot }
export type DigestContent = DigestRendererSlots;
export type DigestContentInput = { tenantId: string; userId: string; role: "owner" | "member"; periodStart: Date; periodEnd: Date };
export interface DigestContentStore { loadDigestContent(input: DigestContentInput): Promise<DigestContent> }
export type DigestFacts = {
  members: Array<{ userId: string; role: "owner" | "member" }>;
  verdicts: Array<{ id: string; userId: string; label: VerdictLabel; headline: string; createdAt: Date }>;
  alerts: Array<{ id: string; subjectUserId: string | null; kind: string; severity: Severity; createdAt: Date }>;
  devices: Array<{ userId: string; lastSeenAt: Date | null; createdAt: Date; revokedAt: Date | null }>;
};
const labels: VerdictLabel[] = ["malicious", "suspicious", "likely_safe", "insufficient_evidence"];
const safeAlertLabels: Record<string, string> = {
  member_verdict: "Security check alert", member_left: "Household membership changed", device_removed: "Device removed or uninstalled",
  scam_page: "Possible scam page", dangerous_site: "Dangerous site alert", remote_access: "Remote access alert",
  unwanted_software: "Unwanted software alert", permission_grant: "Device permission alert", scam_in_progress: "Possible scam in progress", breach_detected: "Breach exposure alert", mailbox_forwarding: "Mailbox forwarding alert",
};
/** Redact network identifiers before truncation (including bare domains, IPs, emails, hashes and phone/token runs). */
export function digestHeadline(value: string): string {
  return truncate(cleanText(value)
    .replace(/(?:https?:\/\/|www\.)\S+|\b[^\s<>@]+@[^\s<>@]+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?|\b(?:\d{1,3}\.){3}\d{1,3}\b|\b[a-f0-9]{32,}\b|(?<!\d)\d{7,}(?!\d)|(?<![a-z0-9])[a-z0-9]{24,}(?![a-z0-9])/gi, "[redacted]"), 140) || "Security check";
}
export function selectDigestContent(input: DigestContentInput, facts: DigestFacts): DigestContent {
  const member = facts.members.find(m => m.userId === input.userId);
  if (!member || member.role !== input.role) return {};
  const within = (row: { createdAt: Date }) => row.createdAt >= input.periodStart && row.createdAt < input.periodEnd;
  const content: DigestContent = {};
  const personal = facts.verdicts.filter(v => v.userId === input.userId && within(v));
  if (personal.length) content.personal = {
    verdictCounts: labels.map(label => ({ label, count: personal.filter(v => v.label === label).length })),
    topVerdicts: personal.sort((a, b) => verdictSeverityRank(b.label) - verdictSeverityRank(a.label) || +b.createdAt - +a.createdAt || a.id.localeCompare(b.id)).slice(0, 3)
      .map(v => ({ id: v.id, label: v.label, headline: digestHeadline(v.headline), createdAt: v.createdAt.toISOString(), href: `/verdicts/${encodeURIComponent(v.id)}` })),
  };
  if (member.role === "owner") {
    const memberIds = new Set(facts.members.filter(m => m.role === "member").map(m => m.userId));
    const eligible = facts.alerts.filter(a => a.subjectUserId !== input.userId && within(a) && verdictSeverityRank(a.severity) >= 2 && safeAlertLabels[a.kind]);
    const offline = facts.devices.filter(d => memberIds.has(d.userId) && !d.revokedAt && +(d.lastSeenAt ?? d.createdAt) <= +input.periodEnd - 48 * 3600000).length;
    if (eligible.length || offline) content.household = {
      alertCounts: (["critical", "high", "medium"] as Severity[]).map(severity => ({ severity, count: eligible.filter(a => a.severity === severity).length })).filter(a => a.count > 0),
      topAlerts: eligible.sort((a, b) => verdictSeverityRank(b.severity) - verdictSeverityRank(a.severity) || +b.createdAt - +a.createdAt || a.id.localeCompare(b.id)).slice(0, 3)
        .map(a => ({ label: safeAlertLabels[a.kind]!, severity: a.severity, createdAt: a.createdAt.toISOString(), href: "/settings/household" })),
      devices: { offline, removedOrUninstalled: eligible.filter(a => a.kind === "device_removed").length },
    };
  }
  return content;
}
