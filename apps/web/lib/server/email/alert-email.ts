/**
 * Alert emails to household owners (_specs/owner-alerts.md). Title and body may
 * quote a model-written headline, so everything is escaped; the only links are
 * Neo's own (the verdict page or household settings).
 */
import { cleanText, escapeHtml, truncate, type RenderedEmail } from "./verdict-email";

const SEVERITY_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  critical: { bg: "#fee2e2", fg: "#991b1b", label: "Critical" },
  high: { bg: "#fee2e2", fg: "#991b1b", label: "High" },
  medium: { bg: "#fef3c7", fg: "#92400e", label: "Medium" },
  low: { bg: "#e5e7eb", fg: "#374151", label: "Low" },
};

export const ALERT_FOOTER = "You get these because you own a household on Neo. Change which alerts are emailed under Settings → Household.";

function safeUrl(url: string): string {
  const u = new URL(url);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("link must be http(s)");
  return u.toString();
}

function layout(title: string, inner: string): string {
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(title)}</title></head>`,
    '<body style="margin:0;padding:0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827">',
    '<div style="max-width:560px;margin:0 auto;padding:24px 16px">',
    '<div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:24px">',
    inner,
    "</div>",
    `<p style="font-size:12px;color:#6b7280;margin:16px 4px 0">${escapeHtml(ALERT_FOOTER)}</p>`,
    "</div></body></html>",
  ].join("");
}

export function renderAlertEmail(input: {
  severity: string;
  title: string;
  body: string;
  link: { url: string; label: string };
}): RenderedEmail {
  const title = truncate(cleanText(input.title), 140);
  const body = truncate(cleanText(input.body), 1000);
  const style = SEVERITY_STYLE[input.severity] ?? SEVERITY_STYLE.low!;
  const url = safeUrl(input.link.url);
  const subject = `Neo alert: ${title}`;
  const html = layout(
    subject,
    [
      `<span style="display:inline-block;padding:2px 10px;border-radius:999px;font-size:13px;font-weight:600;background:${style.bg};color:${style.fg}">${escapeHtml(style.label)}</span>`,
      `<h1 style="font-size:18px;line-height:1.4;margin:12px 0 8px">${escapeHtml(title)}</h1>`,
      `<p style="font-size:14px;line-height:1.5;margin:0 0 16px">${escapeHtml(body)}</p>`,
      `<p style="margin:20px 0 0"><a href="${escapeHtml(url)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px;font-weight:600">${escapeHtml(input.link.label)}</a></p>`,
    ].join(""),
  );
  return { subject, html, text: [title, "", body, "", `${input.link.label}: ${url}`, "", ALERT_FOOTER].join("\n") };
}

export function renderAlertCapEmail(input: { dashboardUrl: string; cap: number }): RenderedEmail {
  const url = safeUrl(input.dashboardUrl);
  const subject = "Neo alert: more alerts than usual today";
  const body = `Your household has had more than ${input.cap} alerts today. Neo will not email you about more of them until tomorrow (UTC); they are all on your dashboard.`;
  const html = layout(
    subject,
    [
      `<h1 style="font-size:18px;line-height:1.4;margin:0 0 8px">More alerts than usual today</h1>`,
      `<p style="font-size:14px;line-height:1.5;margin:0 0 16px">${escapeHtml(body)}</p>`,
      `<p style="margin:20px 0 0"><a href="${escapeHtml(url)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px;font-weight:600">Open your dashboard</a></p>`,
    ].join(""),
  );
  return { subject, html, text: [body, "", url, "", ALERT_FOOTER].join("\n") };
}
