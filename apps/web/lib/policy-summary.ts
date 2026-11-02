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
        ? "Child mode: the same rules as Standard for now."
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
  out.push(`Owners are emailed about ${word(rules.notify?.ownersNotifyAt, "high")} alerts and above (each owner can also set their own limit).`);
  out.push(
    mode === "standard"
      ? "Helpers are only emailed for people in Elder or Child mode."
      : `Helpers are emailed about ${word(rules.notify?.helpersNotifyAt, "high")} alerts and above.`,
  );
  return out;
}

/** `jane.doe@example.com` -> `j***@example.com`. */
export function maskEmail(address: string): string {
  const at = address.lastIndexOf("@");
  if (at < 1) return "***";
  return `${address.slice(0, 1)}***${address.slice(at)}`;
}
