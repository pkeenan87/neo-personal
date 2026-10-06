/**
 * Synthetic sign-in alert fixtures (never real mail). Wording follows the providers' public help pages;
 * user-side values are example.com / example.test / documentation IP ranges. Provider-side hosts are the
 * providers' real domains so the allowlist rules can be exercised.
 */
import type { SignInAlertEvent, SignInAlertProvider } from "../../../src/signin/types.js";

export type AlertCase = {
  template: string;
  provider: SignInAlertProvider;
  event: SignInAlertEvent;
  subject: string;
  lines: string[];
  expect: { device?: string; location?: string; ip?: string[]; time?: string; account_hint?: string };
};

export const PROVIDER_FROM: Record<SignInAlertProvider, string> = {
  google: "Google <no-reply@accounts.google.com>",
  microsoft: "Microsoft account team <account-security-noreply@accountprotection.microsoft.com>",
  apple: "Apple <appleid@id.apple.com>",
  meta: "Facebook <security@facebookmail.com>",
  amazon: "Amazon.com <account-update@amazon.com>",
  paypal: "PayPal <service@paypal.com>",
};

/** Registrable domain that signs each provider's mail, and a real-looking link on it. */
export const PROVIDER_DKIM: Record<SignInAlertProvider, string> = {
  google: "accounts.google.com",
  microsoft: "accountprotection.microsoft.com",
  apple: "id.apple.com",
  meta: "facebookmail.com",
  amazon: "amazon.com",
  paypal: "paypal.com",
};
export const PROVIDER_LINK: Record<SignInAlertProvider, string> = {
  google: "https://myaccount.google.com/notifications",
  microsoft: "https://account.microsoft.com/activity",
  apple: "https://account.apple.com/account/manage",
  meta: "https://www.facebook.com/settings",
  amazon: "https://www.amazon.com/gp/css/homepage.html",
  paypal: "https://www.paypal.com/myaccount/security",
};

const ACCT = "jordan@example.com";
const IP = "203.0.113.24";
const WHEN_LONG = "January 15, 2026 at 12:00 PM UTC";
const TIME = "2026-01-15T12:00:00.000Z";
const NOT_YOU = "If this wasn't you, secure your account now from the official app or website.";

export const CASES: AlertCase[] = [
  {
    template: "google.new_signin.v1", provider: "google", event: "new_signin", subject: "Security alert",
    lines: ["A new sign-in on Windows", `Your Google Account ${ACCT} was just signed in to from a new Windows device. You're getting this email to make sure it was you.`, "Location: Seattle, WA, USA", `IP address: ${IP}`, `Time: ${WHEN_LONG}`, "Check activity", NOT_YOU],
    expect: { device: "Windows", location: "Seattle, WA, USA", ip: [IP], time: TIME, account_hint: "j***@e***.com" },
  },
  {
    template: "google.password_changed.v1", provider: "google", event: "password_changed", subject: "Security alert",
    lines: ["Your Google Account password was changed", `The password for ${ACCT} was changed on ${WHEN_LONG}.`, "Check activity", NOT_YOU],
    expect: { ip: [], time: TIME, account_hint: "j***@e***.com" },
  },
  {
    template: "google.mfa_or_recovery_changed.v1", provider: "google", event: "mfa_or_recovery_changed", subject: "Security alert",
    lines: ["2-Step Verification was turned off for your Google Account", `Time: ${WHEN_LONG}`, "Check activity", NOT_YOU],
    expect: { ip: [], time: TIME },
  },
  {
    template: "google.suspicious_activity.v1", provider: "google", event: "suspicious_activity", subject: "Critical security alert",
    lines: [`Someone just used your password to try to sign in to your Google Account ${ACCT}.`, "Google blocked them, but you should check what happened.", "Location: Lagos, Nigeria", `IP address: ${IP}`, "Check activity", NOT_YOU],
    expect: { location: "Lagos, Nigeria", ip: [IP], account_hint: "j***@e***.com" },
  },
  {
    template: "microsoft.new_signin.v1", provider: "microsoft", event: "new_signin", subject: "Microsoft account security alert",
    lines: ["Microsoft account", "A sign-in from a new device was detected on your account.", "Platform: Windows 10", "Browser: Firefox", "Country/region: United States", "IP address: 198.51.100.7", "Date: 2026-01-15 12:00 UTC", "Review recent activity", NOT_YOU],
    expect: { device: "Windows 10, Firefox", location: "United States", ip: ["198.51.100.7"], time: TIME },
  },
  {
    template: "microsoft.password_changed.v1", provider: "microsoft", event: "password_changed", subject: "Microsoft account password change",
    lines: ["Microsoft account", `The password for the Microsoft account ${ACCT} was changed.`, "Date: 2026-01-15 04:00 -08:00", NOT_YOU],
    expect: { ip: [], time: TIME, account_hint: "j***@e***.com" },
  },
  {
    template: "microsoft.mfa_or_recovery_changed.v1", provider: "microsoft", event: "mfa_or_recovery_changed", subject: "Microsoft account security info was added",
    lines: ["Microsoft account", "New security info was added to your account.", "Date: 2026-01-15 12:00 UTC", NOT_YOU],
    expect: { ip: [], time: TIME },
  },
  {
    template: "microsoft.suspicious_activity.v1", provider: "microsoft", event: "suspicious_activity", subject: "Microsoft account unusual sign-in activity",
    lines: ["Microsoft account", "We detected something unusual about a recent sign-in.", "Country/region: Russia", "IP address: 198.51.100.99", "Date: 2026-01-15 12:00 UTC", NOT_YOU],
    expect: { location: "Russia", ip: ["198.51.100.99"], time: TIME },
  },
  {
    template: "apple.new_signin.v1", provider: "apple", event: "new_signin", subject: "Your Apple Account was used to sign in to iCloud via a web browser",
    lines: [`Your Apple Account (${ACCT}) was used to sign in to iCloud via a web browser.`, "Date and Time: January 15, 2026, 12:00 PM UTC", "Browser: Safari", "Operating System: macOS", "Near: Seattle, WA", "If you recently signed in, you don't need to do anything."],
    expect: { device: "macOS, Safari", location: "Seattle, WA", ip: [], time: TIME, account_hint: "j***@e***.com" },
  },
  {
    template: "apple.new_device.v1", provider: "apple", event: "new_device", subject: "Your Apple Account is being used to sign in on a new device",
    lines: ["Your Apple Account is being used to sign in on a new device.", "Device: iPhone 15", "Near: Portland, OR", "Date: January 15, 2026 at 12:00 PM UTC", NOT_YOU],
    expect: { device: "iPhone 15", location: "Portland, OR", ip: [], time: TIME },
  },
  {
    template: "apple.password_changed.v1", provider: "apple", event: "password_changed", subject: "Your Apple Account password was changed",
    lines: ["The password for your Apple Account was changed.", `Date and Time: ${WHEN_LONG}`, NOT_YOU],
    expect: { ip: [], time: TIME },
  },
  {
    template: "apple.mfa_or_recovery_changed.v1", provider: "apple", event: "mfa_or_recovery_changed", subject: "A trusted phone number was added to your Apple Account",
    lines: ["A trusted phone number was added to your Apple Account.", `Date and Time: ${WHEN_LONG}`, NOT_YOU],
    expect: { ip: [], time: TIME },
  },
  {
    template: "meta.new_signin.v1", provider: "meta", event: "new_signin", subject: "New login to Facebook from Chrome on Windows",
    lines: ["We noticed a new login to your Facebook account.", "Location: Seattle, WA", `IP address: ${IP}`, "Was this you?", NOT_YOU],
    expect: { device: "Chrome on Windows", location: "Seattle, WA", ip: [IP] },
  },
  {
    template: "meta.password_changed.v1", provider: "meta", event: "password_changed", subject: "Your Facebook password was changed",
    lines: ["The password for your Facebook account was changed.", `Time: ${WHEN_LONG}`, NOT_YOU],
    expect: { ip: [], time: TIME },
  },
  {
    template: "meta.suspicious_activity.v1", provider: "meta", event: "suspicious_activity", subject: "Suspicious login attempt blocked on your Instagram account",
    lines: ["We blocked a suspicious login attempt on your Instagram account.", "Location: Kyiv, Ukraine", `IP address: ${IP}`, NOT_YOU],
    expect: { location: "Kyiv, Ukraine", ip: [IP] },
  },
  {
    template: "amazon.new_signin.v1", provider: "amazon", event: "new_signin", subject: "New sign-in to your Amazon account",
    lines: ["We noticed a new sign-in to your Amazon account.", "Device: Chrome on Windows", "Location: Seattle, WA", `Time: ${WHEN_LONG}`, NOT_YOU],
    expect: { device: "Chrome on Windows", location: "Seattle, WA", ip: [], time: TIME },
  },
  {
    template: "amazon.password_changed.v1", provider: "amazon", event: "password_changed", subject: "Your Amazon.com password was changed",
    lines: ["Your Amazon.com password was changed.", `Time: ${WHEN_LONG}`, NOT_YOU],
    expect: { ip: [], time: TIME },
  },
  {
    template: "amazon.mfa_or_recovery_changed.v1", provider: "amazon", event: "mfa_or_recovery_changed", subject: "Two-Step Verification was turned off on your Amazon account",
    lines: ["Two-Step Verification was turned off on your Amazon account.", `Time: ${WHEN_LONG}`, NOT_YOU],
    expect: { ip: [], time: TIME },
  },
  {
    template: "paypal.new_device.v1", provider: "paypal", event: "new_device", subject: "New device login to your PayPal account",
    lines: ["You logged in from a new device.", "Device: Safari on iPhone", "Location: Austin, TX", `Time: ${WHEN_LONG}`, NOT_YOU],
    expect: { device: "Safari on iPhone", location: "Austin, TX", ip: [], time: TIME },
  },
  {
    template: "paypal.password_changed.v1", provider: "paypal", event: "password_changed", subject: "Your PayPal password was changed",
    lines: ["Your PayPal password was changed.", `Time: ${WHEN_LONG}`, NOT_YOU],
    expect: { ip: [], time: TIME },
  },
  {
    template: "paypal.mfa_or_recovery_changed.v1", provider: "paypal", event: "mfa_or_recovery_changed", subject: "A new security key was added to your PayPal account",
    lines: ["A new security key was added to your PayPal account.", `Time: ${WHEN_LONG}`, NOT_YOU],
    expect: { ip: [], time: TIME },
  },
  {
    template: "paypal.suspicious_activity.v1", provider: "paypal", event: "suspicious_activity", subject: "Unusual login activity on your PayPal account",
    lines: ["We noticed unusual login activity on your PayPal account.", "Location: Bucharest, Romania", `IP address: ${IP}`, NOT_YOU],
    expect: { location: "Bucharest, Romania", ip: [IP] },
  },
];

/** Messages that must NOT parse as a sign-in alert. */
export const NEGATIVES: { name: string; subject: string; body: string }[] = [
  { name: "marketing mail from a provider", subject: "New features in your Google Account", body: "Explore the latest tools. Your Google Account has storage tips and more." },
  { name: "altered provider marker", subject: "Security alert", body: "A new sign-in on Windows\nYour G00gle Acc0unt was just signed in to from a new Windows device." },
  { name: "event marker without a provider", subject: "Security alert", body: "A new sign-in on Windows. Check activity." },
  { name: "unsupported language", subject: "Alerta de seguridad", body: "Un nuevo inicio de sesion en tu cuenta de Google Account desde Windows. Revisa la actividad." },
  { name: "ambiguous events", subject: "Security alert", body: "Your Google Account password was changed.\nA new sign-in on Windows was also detected." },
  { name: "conflicting providers", subject: "Security alert", body: "Your Google Account password was changed.\nYour Microsoft account password was changed." },
  { name: "empty", subject: "", body: "" },
];

export type BuildOptions = {
  from: string;
  subject: string;
  lines: string[];
  /** Authentication-Results: pass (aligned), fail, or absent. */
  auth?: "pass" | "fail" | "absent";
  dkimDomain?: string;
  dmarc?: "pass" | "fail";
  links?: string[];
  html?: boolean;
  extraLines?: string[];
};

/** Build an RFC 5322 message. Links are rendered as anchors (HTML) or bare URLs (text). */
export function buildMessage(o: BuildOptions): string {
  const head = [`From: ${o.from}`, "To: jordan@example.com", `Subject: ${o.subject}`, "Date: Thu, 15 Jan 2026 12:00:30 +0000", "MIME-Version: 1.0"];
  const auth = o.auth ?? "pass";
  if (auth !== "absent") {
    const dkim = auth === "pass" ? "pass" : "fail";
    const dmarc = o.dmarc ?? (auth === "pass" ? "pass" : "fail");
    head.unshift(
      "Received: from mail.sender.example.net by mx.example.test with ESMTPS; Thu, 15 Jan 2026 12:00:20 +0000",
      "Authentication-Results: mx.example.test;",
      ` dkim=${dkim} header.d=${o.dkimDomain ?? "accounts.google.com"} header.s=sel1;`,
      " spf=pass smtp.mailfrom=bounce.example.test;",
      ` dmarc=${dmarc} header.from=${(o.from.match(/@([^>\s]+)/)?.[1] ?? "example.test")}`,
    );
  }
  const lines = [...o.lines, ...(o.extraLines ?? [])];
  const links = o.links ?? [];
  if (o.html) {
    const body = lines.map((l) => `<p>${l.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>`).join("\n") + links.map((u) => `\n<p><a href="${u}">Check activity</a></p>`).join("");
    return `${head.join("\n")}\nContent-Type: text/html; charset=utf-8\n\n<html><body>${body}</body></html>\n`;
  }
  return `${head.join("\n")}\nContent-Type: text/plain; charset=utf-8\n\n${[...lines, ...links].join("\n")}\n`;
}

/** The genuine-looking message for a case: provider sender, DKIM-aligned, links on provider domains. */
export function genuine(c: AlertCase, overrides: Partial<BuildOptions> = {}): string {
  return buildMessage({
    from: PROVIDER_FROM[c.provider],
    subject: c.subject,
    lines: c.lines,
    auth: "pass",
    dkimDomain: PROVIDER_DKIM[c.provider],
    links: [PROVIDER_LINK[c.provider]],
    html: true,
    ...overrides,
  });
}
