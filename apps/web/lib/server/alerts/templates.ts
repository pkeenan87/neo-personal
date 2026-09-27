/**
 * Alert text (_specs/owner-alerts.md). Templates only, no model. Names are
 * user-chosen and verdict headlines are model-written after reading attacker
 * content, so every interpolated string is cleaned and truncated here and
 * escaped again by whatever renders it.
 */
import type { Verdict } from "@neo/verdict";
import { cleanText, truncate } from "../email/verdict-email";

export interface AlertText {
  severity: "low" | "medium" | "high" | "critical";
  title: string;
  body: string;
}

const NAME_MAX = 40;
const HEADLINE_MAX = 200;

const SUBJECT_LABELS: Record<Verdict["subject_type"], string> = {
  email: "an email",
  sms: "a text message",
  url: "a link",
  page: "a web page",
  signin_alert: "a sign-in alert",
  file: "a file",
  conversation: "a conversation",
};

export function displayName(name: string | null | undefined, email?: string | null): string {
  const n = truncate(cleanText(name ?? ""), NAME_MAX);
  if (n) return n;
  const local = cleanText(email?.split("@")[0] ?? "");
  return truncate(local, NAME_MAX) || "A member";
}

/** null for verdicts that do not alert (likely safe, not enough evidence). */
export function verdictAlertText(memberName: string, verdict: Verdict, source: "chat" | "inbound" | "api"): AlertText | null {
  if (verdict.verdict !== "malicious" && verdict.verdict !== "suspicious") return null;
  const what = SUBJECT_LABELS[verdict.subject_type] ?? "something";
  const how = source === "inbound" ? `forwarded ${what} to Neo` : `asked Neo about ${what}`;
  const label = verdict.verdict === "malicious" ? "malicious" : "suspicious";
  const headline = truncate(cleanText(verdict.headline), HEADLINE_MAX);
  return {
    severity: verdict.verdict === "malicious" ? "high" : "medium",
    title: `${memberName} checked something ${label}`,
    body: `${memberName} ${how}. Neo's verdict: ${label}. Summary: "${headline}"`,
  };
}

export function joinedAlertText(memberName: string): AlertText {
  return {
    severity: "high",
    title: `${memberName} joined your household`,
    body: `${memberName} accepted an invite and is now a member. If you did not expect this, remove them under Settings → Household.`,
  };
}

export function leftAlertText(memberName: string, removed: boolean): AlertText {
  return removed
    ? { severity: "low", title: `You removed ${memberName}`, body: `${memberName} is no longer a member of your household.` }
    : { severity: "low", title: `${memberName} left your household`, body: `${memberName} left the household. Their checks stay in your history.` };
}

/** UTC hour bucket for membership dedupe keys. */
export function hourBucket(now = new Date()): string {
  return now.toISOString().slice(0, 13);
}
