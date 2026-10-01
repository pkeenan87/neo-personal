/**
 * Alert text (_specs/owner-alerts.md). Templates only, no model. Names are
 * user-chosen and verdict headlines are model-written after reading attacker
 * content, so every interpolated string is cleaned and truncated here and
 * escaped again by whatever renders it.
 */
import type { SignalSeverity } from "@neo/db";
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
  // Device-signal subject types (_specs/signals.md). Not reached today: alertForVerdict is
  // skipped for source "device" (the signal rules raise the device alert themselves), but the
  // map must stay total so it typechecks against Verdict["subject_type"].
  software: "program",
  remote_session: "remote session",
  permission: "permission",
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

// ─── Device signals (_specs/signals.md) ────────────────────────────
//
// Every string interpolated below is device-supplied (tool/program/app names, domains, peer
// ids) or model-free but still user-influenced (member/device names): all are cleaned and
// truncated by the caller (deviceLabel/displayName) or by the helpers here. Domains are always
// shown defanged and are never turned into links.

const TOOL_NAME_MAX = 64;
const DOMAIN_LABEL_MAX = 253;

/** `paypa1.test` → `paypa1[.]test`: never a clickable link, never rendered as a real URL. */
export function defangDomain(domain: string | null | undefined): string {
  return truncate(cleanText(domain ?? ""), DOMAIN_LABEL_MAX).replace(/\./g, "[.]");
}

function toolLabel(name: string | null | undefined): string {
  return truncate(cleanText(name ?? ""), TOOL_NAME_MAX) || "a remote-access tool";
}

export function scamPageAlertText(memberName: string, deviceName: string): AlertText {
  return {
    severity: "high",
    title: `${memberName} opened a page with signs of a tech-support scam`,
    body: `Neo saw ${memberName} on ${deviceName} on a page that behaved like a tech-support scam (a fake warning that traps the page and pushes a phone number to call). If ${memberName} already called that number, tell them to hang up and not follow any instructions or install anything.`,
  };
}

export function dangerousSiteAlertText(memberName: string, deviceName: string, domain: string, brand: string | null): AlertText {
  const what = brand ? `a fake ${truncate(cleanText(brand), 64)} login page` : "a page flagged as dangerous";
  return {
    severity: "high",
    title: `${memberName} opened ${what}`,
    body: `Neo saw ${memberName} on ${deviceName} open ${defangDomain(domain)}, ${brand ? "which looks like it is imitating " + truncate(cleanText(brand), 64) : "which is flagged as dangerous"}. Tell ${memberName} not to enter any passwords or personal information there.`,
  };
}

export function remoteAccessInstallAlertText(deviceName: string, tool: string, offVendorDomain: string | null, severity: SignalSeverity = "high"): AlertText {
  const t = toolLabel(tool);
  if (!offVendorDomain && severity === "low") {
    // Marked expected on this device (_specs/signals.md rules table): feed-only, no warning tone.
    return {
      severity,
      title: `${deviceName}: ${t} was installed`,
      body: `${t} was installed on ${deviceName}. It is marked as expected on this device, so Neo is only noting it.`,
    };
  }
  return offVendorDomain
    ? {
        severity: "medium",
        title: `${deviceName}: ${t} was downloaded from an unfamiliar site`,
        body: `${t} was downloaded on ${deviceName} from ${defangDomain(offVendorDomain)}, not its official site. If nobody in your household did this on purpose, treat the device as compromised.`,
      }
    : {
        severity: "high",
        title: `${deviceName}: ${t} was installed`,
        body: `${t}, a remote-access tool, was installed on ${deviceName}. If someone you don't know asked for this, hang up and don't let them connect. Under Settings → Household you can mark a tool as expected if this was intentional.`,
      };
}

/** A remote-access tool that was already on the device when the desktop agent enrolled (`discovery: "baseline"`). */
export function remoteAccessBaselineAlertText(deviceName: string, tool: string, severity: SignalSeverity): AlertText {
  const t = toolLabel(tool);
  return {
    severity,
    title: `${deviceName}: ${t} is installed`,
    body: `${t}, a remote-access tool, was already installed on ${deviceName} when Neo was set up there. If it belongs there, mark it as expected under Settings → Household. If nobody remembers installing it, ask ${deviceName}'s user about it and consider uninstalling it.`,
  };
}

export function remoteAccessSessionAlertText(deviceName: string, tool: string, peerId: string | null, severity: SignalSeverity): AlertText {
  const t = toolLabel(tool);
  const peer = peerId ? ` (ID ${truncate(cleanText(peerId), 64)})` : "";
  const title = `Someone connected to ${deviceName} with ${t}${peer}`;
  const body =
    severity === "low"
      ? `A remote-access session started on ${deviceName} with ${t}${peer}, from a peer ID you've marked expected. No action needed unless this is unexpected.`
      : `A remote-access session started on ${deviceName} with ${t}${peer}. If you don't recognize this, disconnect it now and check in with whoever uses this device.`;
  return { severity, title, body };
}

export function unwantedSoftwareAlertText(deviceName: string, program: string, confirmed: boolean): AlertText {
  const p = truncate(cleanText(program), TOOL_NAME_MAX) || "A program";
  return {
    severity: confirmed ? "high" : "medium",
    title: `${deviceName}: ${p} is a known unwanted program`,
    body: confirmed
      ? `${p} on ${deviceName} matched malware signatures when checked. Uninstall it if nobody remembers installing it.`
      : `${p} on ${deviceName} is on Neo's list of unwanted-software publishers. Uninstall it if nobody remembers installing it.`,
  };
}

export function permissionGrantAlertText(deviceName: string, app: string, service: string, isRemoteTool: boolean): AlertText {
  const a = truncate(cleanText(app), TOOL_NAME_MAX) || "An app";
  const s = service.replace(/_/g, " ");
  return {
    severity: isRemoteTool ? "critical" : "medium",
    title: `${deviceName}: ${a} was granted ${s} access`,
    body: isRemoteTool
      ? `${a}, a remote-access tool, was granted ${s} access on ${deviceName}. If you don't recognize this, revoke the permission and disconnect the device from the internet until you're sure.`
      : `${a} was granted ${s} access on ${deviceName}. If you don't recognize this app, revoke the permission under system settings.`,
  };
}

export function warningBypassedAlertText(memberName: string, deviceName: string): AlertText {
  return {
    severity: "high",
    title: `${memberName} dismissed a warning on ${deviceName}`,
    body: `Neo warned ${memberName} on ${deviceName} and the warning was dismissed or bypassed. Check in with ${memberName} about what happened next.`,
  };
}

/** One line per correlated event, in order, e.g. "2:14 PM — a fake Microsoft support page". */
function eventLine(at: Date, label: string): string {
  const time = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
  return `${time} UTC — ${label}`;
}

export function scamInProgressAlertText(memberName: string, events: { at: Date; label: string }[]): AlertText {
  return {
    severity: "critical",
    title: `${memberName} may be on a scam call right now`,
    body: [`Neo saw a scam warning and a remote-access event close together for ${memberName}:`, ...events.map((e) => eventLine(e.at, e.label))].join("\n"),
  };
}
