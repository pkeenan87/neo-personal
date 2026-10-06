import type { SignInAlertEvent, SignInAlertProvider } from "./types.js";

/**
 * Reviewed, versioned, English-only alert templates (_specs/signin-alerts.md "Deterministic parser policy").
 * A template matches only when a provider-specific marker AND an event marker are both present. Every
 * template starts `verified: false`: keep it false until the owner forwards a real alert from that provider
 * and confirms the parser matches it. An unverified template is recognized for analysis but can never
 * authorize `likely_safe`. Changing what a template matches requires a new `version` (and id).
 */
export type SigninTemplate = {
  id: string;
  version: number;
  provider: SignInAlertProvider;
  event: SignInAlertEvent;
  verified: boolean;
  /** Where the wording comes from (public provider help pages; synthetic fixtures are author-reviewed). */
  provenance: string;
  /** Date the template wording was last checked against the source. */
  checked: string;
  /** Provider-specific markers (any one). */
  providerMarkers: RegExp[];
  /** Event/action markers (any one). */
  eventMarkers: RegExp[];
  /** Optional extra patterns (capture group 1) for the device label, tried before the labelled lines. */
  device?: RegExp[];
  location?: RegExp[];
};

const CHECKED = "2026-10-05";
const GOOGLE = "https://support.google.com/accounts/answer/2733203 (Google security alerts)";
const MICROSOFT = "https://support.microsoft.com/account-billing (Microsoft account security alerts)";
const APPLE = "https://support.apple.com/102650 (Apple Account security emails)";
const META = "https://www.facebook.com/help/ (Facebook and Instagram login alerts)";
const AMAZON = "https://www.amazon.com/gp/help/customer/ (Amazon account security notices)";
const PAYPAL = "https://www.paypal.com/us/cshelp/ (PayPal security notifications)";

const G = [/\bgoogle account\b/i];
const M = [/\bmicrosoft account\b/i];
const A = [/\bapple (account|id)\b/i];
const F = [/\b(facebook|instagram)\b/i];
const Z = [/\bamazon\b/i];
const P = [/\bpaypal\b/i];

const t = (
  provider: SignInAlertProvider,
  event: SignInAlertEvent,
  provenance: string,
  providerMarkers: RegExp[],
  eventMarkers: RegExp[],
  extra: Pick<SigninTemplate, "device" | "location"> = {},
): SigninTemplate => ({
  id: `${provider}.${event}.v1`,
  version: 1,
  provider,
  event,
  verified: false,
  provenance,
  checked: CHECKED,
  providerMarkers,
  eventMarkers,
  ...extra,
});

export const SIGNIN_TEMPLATES: readonly SigninTemplate[] = [
  t("google", "new_signin", GOOGLE, G, [/\bnew sign-?in (on|to|from)\b/i], {
    device: [/new sign-?in on ([^\n.]{1,60})/i, /signed in to from a new ([^\n.]{1,60}?) device/i],
  }),
  t("google", "password_changed", GOOGLE, G, [/\b(your )?(google account )?password (was|has been) changed\b/i]),
  t("google", "mfa_or_recovery_changed", GOOGLE, G, [
    /\b(2-step verification|two-step verification|recovery (email|phone)( number)?|passkey|security key)\b[^\n.]{0,60}\b(turned (on|off)|added|removed|changed|updated)\b/i,
  ]),
  t("google", "suspicious_activity", GOOGLE, G, [/\bsomeone (just )?(used your password|tried) to (try to )?sign in\b/i, /\bcritical security alert\b/i]),

  t("microsoft", "new_signin", MICROSOFT, M, [/\bsign-?in (from|on) a new (device|location)\b/i, /\bnew sign-?in to your microsoft account\b/i]),
  t("microsoft", "password_changed", MICROSOFT, M, [/\bpassword (was |has been )?changed\b/i, /\bpassword change\b/i]),
  t("microsoft", "mfa_or_recovery_changed", MICROSOFT, M, [/\bsecurity info(rmation)? (was |has been )?(added|removed|changed|updated|replaced)\b/i]),
  t("microsoft", "suspicious_activity", MICROSOFT, M, [/\bunusual sign-?in activity\b/i]),

  t("apple", "new_signin", APPLE, A, [/\bwas used to sign in to\b/i]),
  t("apple", "new_device", APPLE, A, [/\bis being used to sign in on a new device\b/i]),
  t("apple", "password_changed", APPLE, A, [/\bpassword (was |has been )?(changed|reset)\b/i]),
  t("apple", "mfa_or_recovery_changed", APPLE, A, [/\btrusted phone number (was |has been )?(added|removed|changed)\b/i]),

  t("meta", "new_signin", META, F, [/\bnew login (to|from)\b/i], { device: [/new login (?:to \w+ )?from ([^\n.]{1,80})/i] }),
  t("meta", "password_changed", META, F, [/\bpassword (was |has been )?changed\b/i]),
  t("meta", "suspicious_activity", META, F, [/\bsuspicious login attempt\b/i, /\bsomeone tried to log ?in\b/i]),

  t("amazon", "new_signin", AMAZON, Z, [/\bnew sign-?in to your amazon account\b/i, /\bsign-?in attempt from a new device\b/i]),
  t("amazon", "password_changed", AMAZON, Z, [/\byour amazon(\.com)? password (was|has been) changed\b/i]),
  t("amazon", "mfa_or_recovery_changed", AMAZON, Z, [/\btwo-step verification (was |has been )?(turned (on|off)|enabled|disabled|changed)\b/i]),

  t("paypal", "new_device", PAYPAL, P, [/\blog(ged)? in from a new device\b/i]),
  t("paypal", "password_changed", PAYPAL, P, [/\byour paypal password (was|has been) changed\b/i]),
  t("paypal", "mfa_or_recovery_changed", PAYPAL, P, [/\b(security key|phone number|2-step verification)\b[^\n.]{0,60}\b(added|removed|changed|turned (on|off))\b/i]),
  t("paypal", "suspicious_activity", PAYPAL, P, [/\bunusual (login|log-in|account) activity\b/i]),
];
