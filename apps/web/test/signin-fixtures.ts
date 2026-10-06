/** Synthetic sign-in alert mail for the web tests (provider hosts are real domains; user-side values are example.com/.test). */
import { analyzeEmail, type EmailAnalysis } from "@neo/tools";
import type { Verdict, VerdictLabel } from "@neo/verdict";

export const GOOGLE_TEMPLATE = "google.new_signin.v1";
const LINK = "https://myaccount.google.com/notifications";

export const GOOGLE_LINES = [
  "A new sign-in on Windows",
  "Your Google Account jordan@example.com was just signed in to from a new Windows device. You're getting this email to make sure it was you.",
  "Location: Seattle, WA, USA",
  "IP address: 203.0.113.24",
  "Time: January 15, 2026 at 12:00 PM UTC",
  "Check activity",
  "If this wasn't you, secure your account now from the official app or website.",
];

export type AlertOpts = {
  from?: string;
  auth?: "pass" | "fail" | "absent";
  dkimDomain?: string;
  links?: string[];
  extra?: string[];
  lines?: string[];
  subject?: string;
};

export function googleAlertRaw(o: AlertOpts = {}): string {
  const auth = o.auth ?? "pass";
  const head = [`From: ${o.from ?? "Google <no-reply@accounts.google.com>"}`, "To: jordan@example.com", `Subject: ${o.subject ?? "Security alert"}`, "Date: Thu, 15 Jan 2026 12:00:30 +0000", "MIME-Version: 1.0"];
  if (auth !== "absent") {
    head.unshift("Received: from mail.sender.example.net by mx.example.test with ESMTPS; Thu, 15 Jan 2026 12:00:20 +0000", "Authentication-Results: mx.example.test;", ` dkim=${auth} header.d=${o.dkimDomain ?? "accounts.google.com"} header.s=s1;`, " spf=pass smtp.mailfrom=bounce.example.test;", ` dmarc=${auth} header.from=google.com`);
  }
  const body = [...(o.lines ?? GOOGLE_LINES), ...(o.extra ?? [])].map((l) => `<p>${l.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>`).join("\n");
  const links = (o.links ?? [LINK]).map((u) => `<p><a href="${u}">Check activity</a></p>`).join("\n");
  return `${head.join("\n")}\nContent-Type: text/html; charset=utf-8\n\n<html><body>${body}\n${links}</body></html>\n`;
}

/** A user's quoted forward: original authentication is gone. */
export function googleForwardedRaw(): string {
  return [
    "From: Jordan Example <jordan@example.com>", "To: check-fixture0000@neo.test", "Subject: Fwd: Security alert", "Date: Fri, 16 Jan 2026 18:20:00 +0000", "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8", "", "Is this real?", "", "---------- Forwarded message ---------", "From: Google <no-reply@accounts.google.com>",
    "Date: Fri, Jan 16, 2026 at 9:14 AM", "Subject: Security alert", "To: <jordan@example.com>", "", ...GOOGLE_LINES, "",
  ].join("\n");
}

export const analyzeRaw = (raw: string): Promise<EmailAnalysis> => analyzeEmail({ raw }, { deps: { mock: true, env: {} } });

export const GOOGLE_VERIFIED = [{ id: GOOGLE_TEMPLATE, verified: true }];

/** A model/triage verdict as the triage step would return it. */
export function triaged(label: VerdictLabel, patch: Partial<Verdict> = {}): Verdict {
  return {
    subject_type: "email",
    verdict: label,
    confidence: 0.8,
    headline: "Model headline",
    indicators: [{ severity: "low", category: "model_note", evidence: "e", explanation: "x" }],
    recommended_actions: [{ action: "Model action", urgency: "soon" }],
    iocs: { urls: [], domains: [], ips: [], hashes: [], phone_numbers: [] },
    ...patch,
  };
}
