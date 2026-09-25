/**
 * Notification emails for forward-to-address (_specs/forward-to-address.md).
 *
 * Every string that reaches these templates is untrusted: the forwarded subject
 * comes from the attacker's message and the verdict text was written by a
 * model that read it. All of it is HTML-escaped, control characters are
 * stripped, and the only link in the email is our own `detailUrl`. No HTML or
 * links from the analyzed message are ever included.
 */
import { verdictSeverityRank, type Verdict, type VerdictLabel } from "@neo/verdict";

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export const VERDICT_EMAIL_LABELS: Record<VerdictLabel, string> = {
  malicious: "Malicious",
  suspicious: "Suspicious",
  likely_safe: "Likely safe",
  insufficient_evidence: "Not enough evidence",
};

const LABEL_COLORS: Record<VerdictLabel, { bg: string; fg: string }> = {
  malicious: { bg: "#fee2e2", fg: "#991b1b" },
  suspicious: { bg: "#fef3c7", fg: "#92400e" },
  likely_safe: { bg: "#dcfce7", fg: "#166534" },
  insufficient_evidence: { bg: "#e5e7eb", fg: "#374151" },
};

export const SUBJECT_MAX = 60;
export const EVIDENCE_MAX = 200;
export const MAX_INDICATORS = 3;
export const FOOTER_TEXT = "Replying to this email does nothing; ask Neo in the app.";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Collapse whitespace and drop control / bidi-override characters (header injection, spoofed text direction). */
export function cleanText(s: string): string {
  return s
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Truncate to at most `max` characters (by code point), ending with "…" when cut. */
export function truncate(s: string, max: number): string {
  const chars = [...s];
  if (chars.length <= max) return s;
  return chars.slice(0, Math.max(0, max - 1)).join("").trimEnd() + "…";
}

function safeUrl(url: string): string {
  const u = new URL(url);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("detailUrl must be http(s)");
  return u.toString();
}

function layout(title: string, bodyHtml: string): string {
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(title)}</title></head>`,
    '<body style="margin:0;padding:0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827">',
    '<div style="max-width:560px;margin:0 auto;padding:24px 16px">',
    '<div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:24px">',
    bodyHtml,
    "</div>",
    `<p style="font-size:12px;color:#6b7280;margin:16px 4px 0">${escapeHtml(FOOTER_TEXT)}</p>`,
    "</div></body></html>",
  ].join("");
}

export interface VerdictEmailOptions {
  detailUrl: string;
  forwardedSubject?: string | null;
  /** Shown when the household has less than 20% of its monthly checks left. */
  usage?: { remaining: number; limit: number };
}

function usageNote(usage: VerdictEmailOptions["usage"]): string | undefined {
  if (!usage || usage.limit <= 0 || usage.remaining / usage.limit >= 0.2) return undefined;
  return `Your household has ${usage.remaining} of ${usage.limit} checks left this month.`;
}

export function renderVerdictEmail(verdict: Verdict, opts: VerdictEmailOptions): RenderedEmail {
  const label = VERDICT_EMAIL_LABELS[verdict.verdict];
  const colors = LABEL_COLORS[verdict.verdict];
  const detailUrl = safeUrl(opts.detailUrl);
  const fwd = truncate(cleanText(opts.forwardedSubject ?? ""), SUBJECT_MAX) || "(no subject)";
  const subject = `Neo: ${label} — "${fwd}"`;
  const headline = cleanText(verdict.headline);

  const indicators = [...verdict.indicators]
    .sort((a, b) => verdictSeverityRank(b.severity) - verdictSeverityRank(a.severity))
    .slice(0, MAX_INDICATORS)
    .map((i) => ({
      severity: i.severity,
      category: truncate(cleanText(i.category), 80),
      evidence: truncate(cleanText(i.evidence), EVIDENCE_MAX),
      explanation: truncate(cleanText(i.explanation), 300),
    }));
  const actions = verdict.recommended_actions.slice(0, 5).map((a) => ({
    urgency: a.urgency,
    action: truncate(cleanText(a.action), 200),
  }));
  const note = usageNote(opts.usage);

  const html = layout(
    subject,
    [
      `<span style="display:inline-block;padding:2px 10px;border-radius:999px;font-size:13px;font-weight:600;background:${colors.bg};color:${colors.fg}">${escapeHtml(label)}</span>`,
      `<h1 style="font-size:18px;line-height:1.4;margin:12px 0 4px">${escapeHtml(headline)}</h1>`,
      `<p style="font-size:13px;color:#6b7280;margin:0 0 16px">About the message you forwarded: &ldquo;${escapeHtml(fwd)}&rdquo;</p>`,
      indicators.length
        ? `<h2 style="font-size:14px;margin:16px 0 8px">Why</h2><ul style="padding-left:18px;margin:0">${indicators
            .map(
              (i) =>
                `<li style="margin:0 0 10px;font-size:14px"><strong>${escapeHtml(i.category)}</strong> <span style="color:#6b7280">(${escapeHtml(i.severity)})</span><br>` +
                `<q style="color:#374151">${escapeHtml(i.evidence)}</q><br>${escapeHtml(i.explanation)}</li>`,
            )
            .join("")}</ul>`
        : "",
      actions.length
        ? `<h2 style="font-size:14px;margin:16px 0 8px">What to do</h2><ul style="padding-left:18px;margin:0">${actions
            .map((a) => `<li style="margin:0 0 6px;font-size:14px">${escapeHtml(a.action)} <span style="color:#6b7280">(${escapeHtml(a.urgency)})</span></li>`)
            .join("")}</ul>`
        : "",
      `<p style="margin:20px 0 0"><a href="${escapeHtml(detailUrl)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px;font-weight:600">See the full analysis</a></p>`,
      note ? `<p style="font-size:13px;color:#92400e;margin:16px 0 0">${escapeHtml(note)}</p>` : "",
    ].join(""),
  );

  const text = [
    `${label}: ${headline}`,
    `About the message you forwarded: "${fwd}"`,
    "",
    ...(indicators.length
      ? ["Why:", ...indicators.map((i) => `- ${i.category} (${i.severity}): "${i.evidence}" ${i.explanation}`), ""]
      : []),
    ...(actions.length ? ["What to do:", ...actions.map((a) => `- ${a.action} (${a.urgency})`), ""] : []),
    `See the full analysis: ${detailUrl}`,
    ...(note ? ["", note] : []),
    "",
    FOOTER_TEXT,
  ].join("\n");

  return { subject, html, text };
}

export type NoticeKind = "too_large" | "storage_unavailable" | "failed";

/** Emails for messages Neo could not analyze (no verdict). */
export function renderNoticeEmail(kind: NoticeKind, opts: { appUrl: string; forwardedSubject?: string | null }): RenderedEmail {
  const appUrl = safeUrl(opts.appUrl);
  const fwd = truncate(cleanText(opts.forwardedSubject ?? ""), SUBJECT_MAX) || "(no subject)";
  const subject = `Neo: could not analyze — "${fwd}"`;
  const body =
    kind === "too_large"
      ? "This message is larger than 2 MB, so Neo could not analyze it. Open Neo and paste the text or upload the message instead."
      : kind === "storage_unavailable"
        ? "Neo could not store this message for analysis right now. Please try again later, or paste it into Neo."
        : "We could not analyze this message. Please try again later, or paste it into Neo.";
  const html = layout(
    subject,
    [
      `<h1 style="font-size:18px;line-height:1.4;margin:0 0 8px">We could not analyze this message</h1>`,
      `<p style="font-size:13px;color:#6b7280;margin:0 0 12px">About the message you forwarded: &ldquo;${escapeHtml(fwd)}&rdquo;</p>`,
      `<p style="font-size:14px;margin:0 0 16px">${escapeHtml(body)}</p>`,
      `<p style="margin:0"><a href="${escapeHtml(appUrl)}" style="color:#111827;font-weight:600">Open Neo</a></p>`,
    ].join(""),
  );
  const text = [`We could not analyze this message: "${fwd}"`, "", body, "", `Open Neo: ${appUrl}`, "", FOOTER_TEXT].join("\n");
  return { subject, html, text };
}

/** The over-cap verdict stored and emailed when the household is out of checks. */
export function overCapVerdict(resetAt: Date): Verdict {
  const date = resetAt.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
  return {
    subject_type: "email",
    verdict: "insufficient_evidence",
    confidence: 0,
    headline: "Not analyzed: your household reached its monthly limit",
    indicators: [],
    recommended_actions: [
      { action: `Checks reset on ${date}. Until then, don't click links in messages you are unsure about.`, urgency: "soon" },
    ],
    iocs: { urls: [], domains: [], ips: [], hashes: [], phone_numbers: [] },
  };
}
