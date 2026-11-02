/** The effective policy of one member in plain words (the member console, _specs/v2-m1-elder.md section 8). Pure. */
import type { PolicyRules } from "@neo/verdict";
import type { MemberModeName } from "./member-types";

const WORD: Record<string, string> = { low: "low", medium: "medium", high: "high", critical: "critical" };
const word = (s: string | undefined, fallback: string) => (s ? (WORD[s] ?? fallback) : fallback);

export function describePolicy(mode: MemberModeName, rules: PolicyRules): string[] {
  const out: string[] = [];
  out.push(
    mode === "elder"
      ? "Elder mode: Neo treats anything that looks like a scam in progress as urgent and tells the helpers straight away."
      : mode === "child"
        ? "Child mode: Neo blocks the sites, apps and screen time you choose below, and tells you when something looks wrong."
        : "Standard mode: Neo raises alerts as it always has.",
  );
  out.push(`A remote session from an ID you have not approved is treated as ${word(rules.remote_access?.unknownPeerSeverity, "high")}.`);
  if (rules.remote_access?.sessionWindowMinutes) {
    out.push(`An install or a new permission within ${rules.remote_access.sessionWindowMinutes} minutes of a remote session is treated as critical.`);
  }
  if (rules.payments?.underPressureWindowMinutes) {
    out.push(`A payment page within ${rules.payments.underPressureWindowMinutes} minutes of a scam page or remote session is treated as critical.`);
  }
  if (rules.devices?.protectionDisabledSeverity) {
    out.push(`Turning off Neo's protection on a device raises a ${word(rules.devices.protectionDisabledSeverity, "high")} alert.`);
  }
  if (mode === "child") out.push(...describeChild(rules));
  out.push(`Owners are emailed about ${word(rules.notify?.ownersNotifyAt, "high")} alerts and above (each owner can also set their own limit).`);
  out.push(
    mode === "standard"
      ? "Helpers are only emailed for people in Elder or Child mode."
      : `Helpers are emailed about ${word(rules.notify?.helpersNotifyAt, "high")} alerts and above.`,
  );
  return out;
}

const CATEGORY_LABEL: Record<string, string> = {
  adult: "adult content",
  gambling: "gambling",
  weapons: "weapons",
  self_harm: "self-harm",
  drugs: "drugs",
  proxy_vpn: "proxies and VPNs",
  social: "social media",
  games: "games",
  streaming: "streaming",
  dating: "dating",
};

function hours(minutes: number): string {
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
  return `${minutes} minutes`;
}

/** Child-mode lines: what is blocked, app approval, screen time and downtime. */
function describeChild(rules: PolicyRules): string[] {
  const out: string[] = [];
  const cats = rules.web?.categories ?? [];
  out.push(cats.length ? `Blocked web categories: ${cats.map((c) => CATEGORY_LABEL[c] ?? c).join(", ")}.` : "No web categories are blocked.");
  if (rules.web?.safeSearch) out.push(`SafeSearch is on${rules.web.youtubeRestricted && rules.web.youtubeRestricted !== "off" ? `, and YouTube is in ${rules.web.youtubeRestricted} restricted mode` : ""}.`);
  out.push(rules.apps?.requireApproval ? "New apps need your approval before they can be opened." : "New apps are allowed. Neo keeps a record of them; nothing is blocked.");
  const days = rules.screenTime?.dailyMinutes ?? {};
  const weekdays = new Set([days.mon, days.tue, days.wed, days.thu, days.fri]);
  const weekend = new Set([days.sat, days.sun]);
  if (weekdays.size === 1 && weekend.size === 1) {
    const [wd] = [...weekdays];
    const [we] = [...weekend];
    if (wd == null && we == null) out.push("There is no daily screen-time limit.");
    else out.push(`Screen time: ${wd == null ? "no limit" : hours(wd)} on weekdays and ${we == null ? "no limit" : hours(we)} at weekends.`);
  } else {
    out.push("Screen time is set day by day.");
  }
  const down = rules.screenTime?.downtime ?? [];
  if (down.length) out.push(`Downtime: ${down.map((w) => `${w.start} to ${w.end}`).join(", ")}.`);
  return out;
}

/** `jane.doe@example.com` -> `j***@example.com`. */
export function maskEmail(address: string): string {
  const at = address.lastIndexOf("@");
  if (at < 1) return "***";
  return `${address.slice(0, 1)}***${address.slice(at)}`;
}
