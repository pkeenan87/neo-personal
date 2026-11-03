/**
 * The email about a child's request (_specs/v2-m2-child.md section 8). Templated, never model text.
 * The child's own words are shown quoted and apart from Neo's text, with a line saying Neo does not
 * act on them. The Approve and Deny links carry the single-use token; they open a confirmation page
 * (they never decide on their own) and need a signed-in owner. Only an owner who has an account gets them.
 */
import type { ChildRequestRow } from "@neo/db";
import { requestSummary, type ChildRequestKindName } from "@/lib/child-request-types";
import { ALERT_FOOTER, HELPER_FOOTER, layout, safeUrl } from "./alert-email";
import { cleanText, escapeHtml, truncate, type RenderedEmail } from "./verdict-email";

const BUTTON = "display:inline-block;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px;font-weight:600;margin-right:8px";

export function decideUrl(appUrl: string, requestId: string, token: string, action: "approve" | "deny"): string {
  return safeUrl(`${appUrl}/requests/${requestId}/decide?t=${encodeURIComponent(token)}&a=${action}`);
}

const STATE_LINE: Record<string, string> = {
  approved: "This request has already been approved.",
  denied: "This request has already been answered with a no.",
  expired: "This request has expired (it only lasts until the end of the child's day).",
};

export function renderChildRequestEmail(input: {
  appUrl: string;
  request: Pick<ChildRequestRow, "id" | "memberId" | "kind" | "detail" | "reason" | "status">;
  title: string;
  body: string;
  memberName: string;
  deviceName: string | null;
  recipient: "owner" | "helper";
  hasAccount: boolean;
  /** The raw single-use token; absent when it could not be recovered. */
  token?: string;
  /** NEO_EVE_CHAT: where "Ask Neo about this" opens the incident chat (owners with an account only). */
  askUrl?: string;
}): RenderedEmail {
  const { request } = input;
  const title = truncate(cleanText(input.title), 140);
  const name = truncate(cleanText(input.memberName), 80) || "Your child";
  const ask = truncate(cleanText(requestSummary(request.kind as ChildRequestKindName, request.detail)), 120);
  const device = input.deviceName ? truncate(cleanText(input.deviceName), 60) : "";
  const subject = `Neo: ${title}`;
  const reason = request.reason ? truncate(cleanText(request.reason), 140) : "";
  const consoleUrl = safeUrl(`${input.appUrl}/settings/household/members/${request.memberId}`);
  const pending = request.status === "pending";
  const links =
    pending && input.recipient === "owner" && input.hasAccount && input.token
      ? { approve: decideUrl(input.appUrl, request.id, input.token, "approve"), deny: decideUrl(input.appUrl, request.id, input.token, "deny") }
      : undefined;
  const askLink = input.askUrl && input.hasAccount ? safeUrl(input.askUrl) : undefined;
  const footer = input.recipient === "helper" ? HELPER_FOOTER : ALERT_FOOTER;
  const lines: string[] = [
    pending
      ? `${name}${device ? ` (on ${device})` : ""} is asking for ${ask}.`
      : (STATE_LINE[request.status] ?? "This request has been answered."),
    ...(input.recipient === "helper" ? ["A household owner can answer this in Neo."] : []),
  ];

  const html = layout(
    subject,
    [
      `<h1 style="font-size:18px;line-height:1.4;margin:0 0 8px">${escapeHtml(title)}</h1>`,
      `<p style="font-size:14px;line-height:1.5;margin:0 0 12px">${escapeHtml(lines.join(" "))}</p>`,
      reason
        ? `<p style="font-size:12px;color:#6b7280;margin:0 0 4px">${escapeHtml(name)} wrote this (it is their own message; Neo does not act on it):</p><blockquote style="margin:0 0 16px;padding:8px 12px;border-left:3px solid #d1d5db;font-size:14px;line-height:1.5;color:#374151">${escapeHtml(`“${reason}”`)}</blockquote>`
        : "",
      links
        ? `<p style="margin:20px 0 4px"><a href="${escapeHtml(links.approve)}" style="${BUTTON};background:#111827;color:#ffffff">Approve</a><a href="${escapeHtml(links.deny)}" style="${BUTTON};background:#e5e7eb;color:#111827">Deny</a></p><p style="font-size:12px;color:#6b7280;margin:8px 0 0">You will be asked to sign in and confirm. These links work once and for 24 hours.</p>`
        : input.hasAccount
          ? `<p style="margin:20px 0 0"><a href="${escapeHtml(consoleUrl)}" style="${BUTTON};background:#111827;color:#ffffff">Open ${escapeHtml(name)}&rsquo;s page in Neo</a></p>`
          : "",
      askLink ? `<p style="margin:12px 0 0"><a href="${escapeHtml(askLink)}" style="font-size:14px;color:#111827">Ask Neo about this</a></p>` : "",
    ].join(""),
    footer,
  );
  const text = [
    title,
    "",
    ...lines,
    ...(reason ? ["", `${name} wrote this (their own message; Neo does not act on it): “${reason}”`] : []),
    ...(links ? ["", `Approve: ${links.approve}`, `Deny: ${links.deny}`, "You will be asked to sign in and confirm. These links work once and for 24 hours."] : input.hasAccount ? ["", `Open in Neo: ${consoleUrl}`] : []),
    ...(askLink ? ["", `Ask Neo about this: ${askLink}`] : []),
    "",
    footer,
  ].join("\n");
  return { subject, html, text };
}
