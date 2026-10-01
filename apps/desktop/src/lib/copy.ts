/** Words shown to the member. The warning and consent copy is fixed by `_specs/desktop-agent.md`. */
import type { PermissionService, Rating, Warning } from "./types";

export const OWNER_FALLBACK = "the household owner";

/** Shows a domain without it being clickable or copy-pasteable as a live link (as the extension popup does). */
export function defangDomain(domain: string): string {
  return domain.replace(/\./g, "[.]");
}

export const RATING_COPY: Record<Rating, { label: string; color: string }> = {
  dangerous: { label: "Dangerous", color: "#c0392b" },
  suspicious: { label: "Suspicious", color: "#b8860b" },
  no_known_problems: { label: "No known problems", color: "#2f6f4f" },
  unknown: { label: "Couldn't check", color: "#6b727c" },
};

/** Plain messages for the service's error codes. */
export function errorMessage(code: string, fallback?: string): string {
  switch (code) {
    case "invalid_code":
      return "That code isn't valid, or it has expired.";
    case "server_unreachable":
      return "Couldn't reach Neo. Check your connection and try again.";
    case "agent_unavailable":
      return "Neo Protection isn't running on this computer. Restart the computer and try again.";
    case "rate_limited":
      return "Too many tries. Wait a minute and try again.";
    case "invalid_server_url":
      return "That doesn't look like a valid server address.";
    case "already_enrolled":
      return "This computer is already protected.";
    case "device_limit":
      return "This household has reached its limit of devices.";
    case "disconnected":
      return "This computer is no longer connected to a household.";
    case "not_enrolled":
      return "This computer is not connected to a household.";
    default:
      return fallback ?? "Something went wrong. Try again in a moment.";
  }
}

export function consentText(owner: string | null, household: string): { owner: string; household: string } {
  return { owner: owner ?? OWNER_FALLBACK, household };
}

export const NEVER_SENT = "Neo never sends the list of your programs, your files or your browsing.";

export function sessionHeadline(w: Pick<Warning, "toolName">): string {
  return `Someone is connected to this computer with ${w.toolName}.`;
}

export const SESSION_ADVICE = "If someone called you and asked for this, it is a scam. Hang up the phone and restart your computer. Do not log in to your bank.";

export function toolToast(toolName: string): string {
  return `${toolName} is on this computer. If someone on the phone asked you to install it, it is a scam. Hang up.`;
}

export function unwantedToast(name: string): string {
  return `Neo found ${name}, which is known unwanted software.`;
}

/** What an app can now do, by permission; the general phrase when the service is unknown. */
export function permissionPhrase(service?: PermissionService): string {
  switch (service) {
    case "screen_recording":
      return "see your screen";
    case "accessibility":
      return "control this Mac";
    case "full_disk_access":
      return "read all your files";
    default:
      return "see and control this Mac";
  }
}

export function permissionHeadline(w: Pick<Warning, "toolName" | "service">): string {
  return `${w.toolName} can now ${permissionPhrase(w.service)}.`;
}

export const PERMISSION_ADVICE = "If someone on the phone asked you to allow this, it is a scam. Hang up, then open System Settings \u2192 Privacy & Security and turn it off.";

// ---- macOS: the Full Disk Access step and Uninstall (spec `_specs/desktop-agent-macos.md`) ------

export const FDA_TITLE = "Let Neo check app permissions";
export const FDA_WHY =
  "Scammers make you allow screen recording or control of your Mac so they can take over. With this one setting on, Neo can warn you when an app is newly allowed to do that.";
export const FDA_ONLY_SETTING = "This is the only setting Neo asks for, and you can turn it off any time.";
export const FDA_NEVER_ON_A_CALL =
  "Neo will never ask you to do this on a phone call. If someone on the phone asks you to open System Settings and allow a program, it is a scam.";
export const FDA_RESTARTING = "Neo is restarting to pick up the change. Wait a few seconds, then press Done again.";
export const FDA_NOT_YET = "Neo can't read it yet. Make sure Neo Protection is switched on in the list, then press Done again.";
export const FDA_GRANTED = "Neo can now check app permissions.";

export function uninstallConfirm(owner: string | null): { headline: string; who: string; rest: string } {
  return {
    headline: "Uninstall Neo?",
    who: owner ?? OWNER_FALLBACK,
    rest: "This removes Neo and its protection from this Mac. You will be asked for an administrator password.",
  };
}
