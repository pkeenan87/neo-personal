/**
 * The plain-language notice an owner reads before Child or Elder mode starts, and the "what is shared"
 * description (_specs/v2-m4-hardening.md section 2). Shared by the console (client) and the server
 * (which refuses to enable a mode unless the owner accepted the current version). Bump
 * `CONSENT_TEXT_VERSION` whenever any wording below changes in substance: old acceptances then no
 * longer match, and the console asks again.
 */
import type { MemberModeName } from "./member-types";

export const CONSENT_TEXT_VERSION = "2026-11-04";

export type ConsentMode = Exclude<MemberModeName, "standard">;

export interface ConsentSection {
  heading: string;
  items: string[];
}

/** What Neo never collects, in every mode. */
export const NEVER_COLLECTED: readonly string[] = [
  "Full web addresses (only the site's domain and category).",
  "The content of messages, emails, pages or forms.",
  "Keystrokes.",
  "Screenshots or screen recordings.",
];

const howToTurnOff = (name: string) =>
  `An owner can switch ${name} back to Standard at any time on ${name}'s page in Settings, then Household. Every owner is emailed when that happens. Removing a device stops that device's reporting straight away.`;

/** The sections the owner reads before enabling `mode` for a member called `name`. */
export function consentSections(mode: ConsentMode, name: string): ConsentSection[] {
  const watches =
    mode === "child"
      ? [
          `Which category a website belongs to (for example games or adult content) and its domain, when ${name} reaches a blocked site. Sites are blocked or allowed by category.`,
          `Which apps are blocked or waiting for approval on ${name}'s computer, and how much screen time has been used each day.`,
          `The requests ${name} sends you for more time, an unblocked site or a new app, including the short reason they type.`,
          "Signs of tampering, such as the clock being changed or Neo being switched off.",
          "Scams, remote-access tools and risky downloads, as in Standard mode.",
        ]
      : [
          `Scam pages and fake login pages ${name} visits (the site's domain only), remote-access tools and flagged programs on their devices, and sign-ins that look unusual.`,
          `When something serious happens, Neo emails ${name}'s helpers straight away, not only the owners.`,
        ];
  const whoSees = [
    mode === "child"
      ? `Every owner of the household, and the helpers you choose for ${name}. ${name} can also see the alerts about them.`
      : `Every owner of the household, and the helpers you choose for ${name}, who are emailed about serious alerts. ${name} can also see the alerts about them.`,
  ];
  return [
    { heading: "What Neo watches", items: watches },
    { heading: "What Neo never collects", items: [...NEVER_COLLECTED] },
    { heading: "Who sees alerts", items: whoSees },
    { heading: "How to turn it off", items: [howToTurnOff(name)] },
  ];
}

/** The line the owner ticks to attest that an elder agreed in person. */
export function elderAttestationText(name: string, helperNames: string[]): string {
  const list = helperNames.length > 0 ? helperNames.join(", ") : "no one yet";
  return `I set this up with ${name} in person and they agreed to these helpers: ${list}.`;
}

export type SharedDeviceKind = "browser_extension" | "desktop_agent";

export interface SharedSummary {
  collected: ConsentSection[];
  neverCollected: string[];
  retention: string[];
}

const DEVICE_LINES: Record<SharedDeviceKind, Record<MemberModeName, string[]>> = {
  browser_extension: {
    standard: ["From the browser extension: the domain of a page that looked like a scam or a fake login. Never the full address or the page."],
    elder: ["From the browser extension: the domain of a page that looked like a scam, a fake login or a payment page. Never the full address or the page."],
    child: [
      "From the browser extension: the domain and category of a site that was blocked, and the domain of a scam page. Never the full address or the page.",
      "The extension applies the blocklists on the device; it does not send browsing history.",
    ],
  },
  desktop_agent: {
    standard: ["From the computer app: the names of remote-access tools and flagged programs, and permission grants (on a Mac). Not a list of everything installed."],
    elder: ["From the computer app: the names of remote-access tools and flagged programs, who connected remotely, and permission grants (on a Mac)."],
    child: [
      "From the computer app: the names of apps that were blocked or are waiting for approval, daily screen-time use, remote-access tools, and signs of tampering.",
      "The app closes blocked apps and locks the screen at the time limit; it does not record what is on screen.",
    ],
  },
};

/** What Neo collects for a member given their mode and the kinds of device they have enrolled. Derived from the constants above. */
export function sharedSummary(mode: MemberModeName, deviceKinds: SharedDeviceKind[], hasAccount: boolean): SharedSummary {
  const kinds = [...new Set(deviceKinds)];
  const about = [
    hasAccount ? "Their account: name, email and sign-in." : "A name for them in the household. They have no account.",
    ...(hasAccount ? ["What they ask Neo to check (links, messages and screenshots they choose to send) and the verdicts."] : []),
    ...(mode === "standard" ? [] : ["The alerts Neo raises about them, with a one-line summary each."]),
  ];
  const collected: ConsentSection[] = [{ heading: "About them", items: about }];
  collected.push({
    heading: "From their devices",
    items: kinds.length === 0 ? ["No device is enrolled, so nothing is collected from a device."] : kinds.flatMap((k) => DEVICE_LINES[k][mode]),
  });
  if (mode === "child") {
    collected.push({
      heading: "Child mode",
      items: ["The requests they send for more time, an unblocked site or an app, with the short reason they type.", "Their age band, worked out from the birth year an owner entered (only the year is kept)."],
    });
  }
  const retention = [
    "By default, device signals are deleted after 30 days, alerts after 180 days (90 days once acknowledged), child requests after 90 days and remembered household facts after a year. A household owner can shorten or lengthen these in household settings.",
    "A removed device is deleted 90 days after removal.",
  ];
  return { collected, neverCollected: [...NEVER_COLLECTED], retention };
}

export const HOW_TO_CHANGE =
  "To change any of this, ask an owner of your household. They can change the mode, the helpers and the devices on your page in Settings, then Household.";
