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

// ─── Devices (_specs/device-enrollment.md) ─────────────────────────

const DEVICE_NAME_MAX = 64;

/** Device names are client- or user-supplied: cleaned and truncated like member names. */
export function deviceLabel(name: string | null | undefined): string {
  return truncate(cleanText(name ?? ""), DEVICE_NAME_MAX) || "A device";
}

export function deviceEnrolledAlertText(memberName: string, deviceName: string): AlertText {
  return {
    severity: "low",
    title: `${memberName} added ${deviceName}`,
    body: `${memberName} signed in on ${deviceName} and approved Neo there. It will report scam warnings about ${memberName} to your household. If you did not expect this, remove it under Settings → Household.`,
  };
}

export function deviceRemovedAlertText(memberName: string, deviceName: string, by: "member" | "device"): AlertText {
  return by === "member"
    ? {
        severity: "high",
        title: `${memberName} removed ${deviceName}`,
        body: `${memberName} removed ${deviceName} from Neo, so it no longer reports scam warnings. Scammers often tell people to remove security software. Check in with ${memberName} if this is unexpected.`,
      }
    : {
        severity: "high",
        title: `${deviceName} was uninstalled`,
        body: `Neo was switched off or uninstalled on ${deviceName} (${memberName}), so it no longer reports scam warnings. Scammers often tell people to remove security software. Check in with ${memberName} if this is unexpected.`,
      };
}

export function deviceOfflineAlertText(memberName: string, deviceName: string, lastSeen: Date | null): AlertText {
  const when = lastSeen
    ? `last checked in on ${lastSeen.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`
    : "has not checked in since it was added";
  return {
    severity: "medium",
    title: `${deviceName} (${memberName}) has not checked in for 2 days`,
    body: `Neo on ${deviceName} ${when}. The device may be switched off or away, or Neo may have been removed from it. Check in with ${memberName} if this is unexpected.`,
  };
}
