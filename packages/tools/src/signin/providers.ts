import type { SignInAlertProvider } from "./types.js";

/**
 * Exact sender addresses and sender domains that provider sign-in alerts come from (English templates).
 * Used by step 5 (Outlook connector) to pre-filter mail; the parser itself never trusts the sender.
 * The `likely_safe` gate (rules.ts) accepts only a From address that exactly matches an entry containing
 * `@`; the bare-domain entries are for pre-filtering only.
 */
export const SIGNIN_ALERT_SENDERS: Readonly<Record<SignInAlertProvider, readonly string[]>> = {
  google: ["no-reply@accounts.google.com"],
  microsoft: ["account-security-noreply@accountprotection.microsoft.com", "accountprotection.microsoft.com"],
  apple: ["appleid@id.apple.com", "id.apple.com"],
  meta: ["security@facebookmail.com", "facebookmail.com", "security@mail.instagram.com", "mail.instagram.com"],
  amazon: ["account-update@amazon.com", "auto-confirm@amazon.com", "no-reply@amazon.com"],
  paypal: ["service@paypal.com", "security@paypal.com"],
};

/**
 * Registrable domains each provider legitimately signs mail with (DKIM d=) and links to. Anything else in a
 * sign-in alert from that provider is off-provider.
 */
export const SIGNIN_ALERT_DOMAINS: Readonly<Record<SignInAlertProvider, readonly string[]>> = {
  google: ["google.com"],
  microsoft: ["microsoft.com", "live.com", "microsoftonline.com"],
  apple: ["apple.com", "icloud.com"],
  meta: ["facebook.com", "facebookmail.com", "instagram.com", "meta.com", "fb.com"],
  amazon: ["amazon.com"],
  paypal: ["paypal.com"],
};

/**
 * Exact link hosts a genuine alert may link to (`likely_safe` gate). A link on any other host, including other
 * hosts of the provider's registrable domain (sites.google.com, docs.google.com, drive.google.com host user
 * content), fails the gate; it is a fake-alert signal only when it is off the provider's registrable domain.
 * Hosts are compared exactly after URL parsing (lower case, punycode, no trailing dot, no userinfo or port).
 *
 * VERIFY AGAINST REAL ALERTS before flipping any template to `verified`: these lists are the best public
 * knowledge, not observed mail, and each real alert may use hosts that are missing here.
 */
export const SIGNIN_ALERT_LINK_HOSTS: Readonly<Record<SignInAlertProvider, readonly string[]>> = {
  google: ["accounts.google.com", "myaccount.google.com", "support.google.com", "g.co"],
  microsoft: ["account.microsoft.com", "account.live.com", "go.microsoft.com", "support.microsoft.com"],
  apple: ["appleid.apple.com", "support.apple.com", "account.apple.com"],
  meta: ["facebook.com", "www.facebook.com", "www.instagram.com", "accountscenter.meta.com"],
  amazon: ["www.amazon.com", "amazon.com"],
  paypal: ["www.paypal.com", "paypal.com"],
};
