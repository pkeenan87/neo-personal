import { digestHeadline, type DigestContent } from "../weekly-digest/content";
import { isDeployedEnvironment, type EnvSource } from "@/lib/env";
import { escapeHtml, VERDICT_EMAIL_LABELS, type RenderedEmail } from "./verdict-email";
export function renderWeeklyDigest(input: DigestContent, unsubscribeUrl: string, source: EnvSource = process.env): RenderedEmail {
  const unsubscribe = new URL(unsubscribeUrl);
  const localHttp = unsubscribe.protocol === "http:" && unsubscribe.hostname === "localhost" && !isDeployedEnvironment(source);
  if ((!localHttp && unsubscribe.protocol !== "https:") || unsubscribe.username || unsubscribe.password) throw new Error("digest unsubscribe must be HTTPS (except non-deployed localhost)");
  const subject = "Your weekly Neo security digest";
  const text = [subject];
  const html = [`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${subject}</title></head><body><h1>${subject}</h1>`];
  const line = (value: string) => { text.push(value); html.push(`<p>${escapeHtml(value)}</p>`); };
  const link = (label: string, path: string) => {
    // Renderer defends its boundary too: never accept caller-supplied external URLs.
    const safe = /^\/verdicts\/[A-Za-z0-9_-]+$/.test(path) || path === "/settings/household" || path === "/settings/hardening" ? path : "/dashboard";
    const href = new URL(safe, unsubscribe.origin).href;
    text.push(`${label}: ${href}`);
    html.push(`<p><a href="${escapeHtml(href)}">${escapeHtml(label)}</a></p>`);
  };
  if (input.personal) {
    html.push("<h2>Your security checks</h2>"); text.push("Your security checks");
    for (const count of input.personal.verdictCounts) line(`${VERDICT_EMAIL_LABELS[count.label]}: ${count.count}`);
    for (const v of input.personal.topVerdicts.slice(0, 3)) link(`${digestHeadline(v.headline)} — ${VERDICT_EMAIL_LABELS[v.label]} (${v.createdAt.slice(0, 10)})`, v.href);
  }
  if (input.household) {
    html.push("<h2>Household summary</h2>"); text.push("Household summary");
    for (const count of input.household.alertCounts) line(`${count.severity} alerts: ${count.count}`);
    for (const alert of input.household.topAlerts.slice(0, 3)) link(`${digestHeadline(alert.label)} — ${alert.severity} (${alert.createdAt.slice(0, 10)})`, "/settings/household");
    if (input.household.devices.offline) line(`Offline member devices: ${input.household.devices.offline}`);
    if (input.household.devices.removedOrUninstalled) line(`Removed or uninstalled member devices: ${input.household.devices.removedOrUninstalled}`);
  }
  if (input.hardeningScore) {
    html.push("<h2>Account hardening</h2>"); text.push("Account hardening");
    const { scorePercent } = input.hardeningScore;
    line(scorePercent === null ? "Your account-hardening score: not enough answers yet" : `Your account-hardening score: ${Math.max(0, Math.min(100, Math.round(scorePercent)))}%`);
    link("Review your checklist", "/settings/hardening");
  }
  // The optional breachStatus slot intentionally has no renderer until step 2.
  line("You receive this because weekly digests are enabled in your Neo settings.");
  text.push(`Unsubscribe: ${unsubscribe.href}`);
  html.push(`<p><a href="${escapeHtml(unsubscribe.href)}">Unsubscribe</a></p></body></html>`);
  return { subject, html: html.join(""), text: text.join("\n") };
}
