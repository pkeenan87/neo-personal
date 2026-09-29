/**
 * Build full `@neo/verdict` `Verdict` objects from signal-rule outcomes
 * (_specs/signals.md "Verdicts"). Templates only, no model: headline, indicators and
 * recommended actions are looked up by detector/reason code. Every device-supplied string
 * (tool/program/app names, domains, peer ids) is attacker-controlled and is cleaned and
 * truncated before it reaches the headline or an indicator's `evidence`.
 */
import { REMOTE_ACCESS_TOOLS, findRemoteAccessTool } from "@neo/tools";
import { VerdictSchema, type Severity as IndicatorSeverity, type SubjectType, type Urgency, type Verdict, type VerdictLabel } from "@neo/verdict";
import type { SignalDetector, SignalEvent } from "@neo/verdict";
import type { SignalSeverity } from "@neo/db";
import { cleanText, truncate } from "../email/verdict-email";

const NAME_MAX = 128;
const DOMAIN_MAX = 253;

function clean(s: string | undefined, max = NAME_MAX): string {
  return truncate(cleanText(s ?? ""), max);
}

/** Signal severity (device_signals/alerts) → indicator severity. Same literal set today; kept as its own mapping in case the sets diverge. */
function toIndicatorSeverity(s: SignalSeverity): IndicatorSeverity {
  return s;
}

/** Signal severity → verdict confidence (0..1). A coarse, documented heuristic: there is no model score to report. */
const CONFIDENCE_BY_SEVERITY: Record<SignalSeverity, number> = { critical: 0.95, high: 0.85, medium: 0.65, low: 0.5 };

const SUBJECT_TYPE_BY_DETECTOR: Record<SignalDetector, SubjectType> = {
  tech_support_scam: "page",
  lookalike_login: "page",
  dangerous_site: "page",
  remote_tool_download: "page",
  warning_bypassed: "page",
  remote_access_tool: "software",
  unwanted_software: "software",
  remote_access_session: "remote_session",
  tcc_grant: "permission",
};

/** Plain-language explanation for one indicator/reason code (client-sent indicator codes, or a server reason code from rules.ts). */
const EXPLANATIONS: Record<string, string> = {
  // tech_support_scam indicators
  fullscreen: "The page forced full-screen mode, a tactic used to make a fake warning look like a real system alert.",
  pointer_lock: "The page captured the mouse pointer so the visitor could not easily click away.",
  keyboard_lock: "The page captured keyboard shortcuts (like Alt+Tab or Esc), a tactic used to trap the visitor.",
  looping_audio: "The page played a looping alarm sound to create panic.",
  back_trap: "The page blocked the browser's back button.",
  unload_trap: "The page tried to stop the tab from being closed.",
  support_phone_text: "The page displayed text urging the visitor to call a 'support' phone number.",
  fake_scan: "The page showed a fake virus or security scan result.",
  // lookalike_login indicators
  password_field: "The page has a password entry field.",
  punycode: "The domain uses punycode (disguised international characters) to imitate a real brand's domain.",
  lookalike_skeleton: "The domain's letters closely resemble a known brand's domain.",
  brand_in_subdomain: "A brand name appears in the subdomain of an unrelated domain.",
  new_tab_from_email: "The page was opened from a link in an email.",
  // remote_tool_download
  download_off_vendor_domain: "This tool was downloaded from a site other than its official source.",
  // remote_access_tool
  expected_remote_tool: "The household owner has marked this tool as expected on this device.",
  unexpected_remote_tool: "This remote-access tool was not marked as expected on this device.",
  // unwanted_software
  publisher_list: "This program's publisher is on Neo's list of unwanted-software publishers.",
  hash_list: "This program's file matches a known unwanted-software hash.",
  unsigned_unknown: "This program is unsigned and matched malware signatures when checked against VirusTotal.",
  // remote_access_session
  expected_peer: "This session used a peer ID the owner has marked as expected.",
  unexpected_peer: "This tool is marked expected on this device, but this session's peer ID was not recognized.",
  unexpected_remote_session: "This remote-access session was not expected on this device.",
  // tcc_grant
  expected_remote_tool_permission: "The household owner has marked this tool as expected on this device.",
  unexpected_remote_tool_permission: "This app is a known remote-access tool and was not marked as expected on this device.",
  screen_recording: "This app was granted permission to record the screen.",
  accessibility: "This app was granted accessibility access, which can let it observe or control the device.",
  // warning_bypassed
  warning_bypassed: "A warning about this was shown and then dismissed or bypassed.",
  // dangerous_site / lookalike escalation evidence (lib/server/signals/escalate.ts)
  safe_browsing_prefix: "This domain matched Google Safe Browsing's list of dangerous sites.",
  safe_browsing_match: "Google Safe Browsing flagged this page.",
  virustotal_malicious: "Security vendors on VirusTotal flagged this page as malicious.",
  virustotal_suspicious: "Security vendors on VirusTotal flagged this page as suspicious.",
  urlscan_malicious: "urlscan.io flagged this page as malicious.",
  brand_lookalike_young_domain: "This domain imitates a known brand and was registered very recently.",
  brand_lookalike: "This domain's appearance closely resembles a known brand's domain.",
};

function explanationFor(code: string): string {
  return EXPLANATIONS[code] ?? "This matched one of Neo's detection rules for this kind of event.";
}

function toolName(toolId: string, fallback: string): string {
  return clean(findRemoteAccessTool(toolId)?.name ?? fallback);
}

/** Whether a TCC-granted app's bundle id belongs to a known remote-access tool. */
function isRemoteAccessBundle(bundleId: string | undefined): boolean {
  if (!bundleId) return false;
  const needle = bundleId.toLowerCase();
  return REMOTE_ACCESS_TOOLS.some((t) => t.macos.bundleIds.some((b) => b.toLowerCase() === needle));
}

interface Action {
  action: string;
  urgency: Urgency;
}

const RECOMMENDED_ACTIONS: Record<"scam_page" | "dangerous_site" | "remote_access_install" | "remote_access_session" | "unwanted_software" | "permission_grant", Action[]> = {
  scam_page: [
    { action: "Close the page and don't call the number shown.", urgency: "now" },
    { action: "If you already called, hang up and don't follow their instructions or install anything they ask for.", urgency: "now" },
  ],
  dangerous_site: [{ action: "Close the page. Don't enter any passwords or personal information there.", urgency: "now" }],
  remote_access_install: [
    { action: "If someone you don't know asked you to install this, hang up and don't let them connect.", urgency: "now" },
    { action: "If you don't recognize this program, uninstall it and change your important passwords.", urgency: "soon" },
  ],
  remote_access_session: [
    { action: "If you don't recognize this connection, disconnect it now and turn off the device's network connection if you can.", urgency: "now" },
    { action: "Change your important passwords once the device is disconnected.", urgency: "soon" },
  ],
  unwanted_software: [{ action: "Uninstall this program if you don't remember installing it.", urgency: "soon" }],
  permission_grant: [{ action: "Review this app's permissions in system settings and revoke it if you don't recognize it.", urgency: "soon" }],
};

export interface BuildSignalVerdictInput {
  event: SignalEvent;
  verdict: VerdictLabel;
  severity: SignalSeverity;
  /** Indicator/reason codes from the rule outcome (lib/server/signals/rules.ts `RuleOutcome.reasonCodes`), plus any escalation evidence codes. */
  reasonCodes: string[];
  deviceName: string;
}

function headlineFor(event: SignalEvent, verdict: VerdictLabel, deviceName: string): string {
  const device = clean(deviceName, 64) || "This device";
  switch (event.detector) {
    case "tech_support_scam":
      return `${device} showed a page with signs of a tech-support scam.`;
    case "lookalike_login":
      return verdict === "malicious"
        ? `${device} opened a fake login page for ${clean(event.brand)}.`
        : `${device} opened a page that may be a lookalike of ${clean(event.brand)}'s login page.`;
    case "dangerous_site":
      return `${device} opened a page flagged as dangerous by Google Safe Browsing.`;
    case "remote_tool_download":
      return `${toolName(event.toolId, "A remote-access tool")} was downloaded on ${device} from a site that isn't its official source.`;
    case "remote_access_tool":
      return `${toolName(event.toolId, event.name)} was installed on ${device}.`;
    case "unwanted_software":
      return event.reason === "unsigned_unknown"
        ? `${clean(event.name)} on ${device} matched malware signatures on VirusTotal.`
        : `${clean(event.name)} on ${device} is a known unwanted program.`;
    case "remote_access_session":
      return `Someone connected to ${device} with ${toolName(event.toolId, "a remote-access tool")}${event.peerId ? ` (ID ${clean(event.peerId, 64)})` : ""}.`;
    case "tcc_grant":
      return `${clean(event.app)} was granted ${event.service.replace("_", " ")} access on ${device}.`;
    default:
      return `Neo flagged an event on ${device}.`;
  }
}

function iocsFor(event: SignalEvent): Verdict["iocs"] {
  const iocs: Verdict["iocs"] = { urls: [], domains: [], ips: [], hashes: [], phone_numbers: [] };
  if ("domain" in event) iocs.domains.push(clean(event.domain, DOMAIN_MAX));
  if (event.detector === "tech_support_scam" && event.phone) iocs.phone_numbers.push(event.phone);
  if (event.detector === "unwanted_software" && event.sha256) iocs.hashes.push(event.sha256);
  return iocs;
}

function actionSetFor(event: SignalEvent): Action[] {
  switch (event.detector) {
    case "tech_support_scam":
      return RECOMMENDED_ACTIONS.scam_page;
    case "lookalike_login":
    case "dangerous_site":
      return RECOMMENDED_ACTIONS.dangerous_site;
    case "remote_tool_download":
    case "remote_access_tool":
      return RECOMMENDED_ACTIONS.remote_access_install;
    case "remote_access_session":
      return RECOMMENDED_ACTIONS.remote_access_session;
    case "unwanted_software":
      return RECOMMENDED_ACTIONS.unwanted_software;
    case "tcc_grant":
      return isRemoteAccessBundle(event.bundleId) ? RECOMMENDED_ACTIONS.remote_access_install : RECOMMENDED_ACTIONS.permission_grant;
    default:
      return [];
  }
}

/** Build and validate a `Verdict` for one alerted (or escalation-confirmed) signal event. */
export function buildSignalVerdict(input: BuildSignalVerdictInput): Verdict {
  const { event, verdict, severity, reasonCodes, deviceName } = input;
  const headline = truncate(headlineFor(event, verdict, deviceName), 200);
  const evidence = headline;
  const indicatorSeverity = toIndicatorSeverity(severity);
  const codes = reasonCodes.length ? reasonCodes : [event.detector];
  const draft: Verdict = {
    subject_type: SUBJECT_TYPE_BY_DETECTOR[event.detector],
    verdict,
    confidence: CONFIDENCE_BY_SEVERITY[severity],
    headline,
    indicators: codes.map((code) => ({
      severity: indicatorSeverity,
      category: code,
      evidence,
      explanation: explanationFor(code),
    })),
    recommended_actions: actionSetFor(event),
    iocs: iocsFor(event),
  };
  return VerdictSchema.parse(draft);
}
