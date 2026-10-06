import type { SIGNIN_ALERT_EVENTS, SIGNIN_ALERT_PROVIDERS } from "@neo/verdict";

export type SignInAlertProvider = (typeof SIGNIN_ALERT_PROVIDERS)[number];
export type SignInAlertEvent = (typeof SIGNIN_ALERT_EVENTS)[number];

/**
 * Facts read from a recognized (English) provider sign-in alert. A template match means "matches a known
 * alert format", never that the sender is genuine. Every string is attacker-controlled, sanitized and bounded.
 */
export type SignInAlert = {
  template_id: string;
  provider: SignInAlertProvider;
  event: SignInAlertEvent;
  /** UTC ISO-8601, only when the alert gave an unambiguous timezone or offset. */
  event_time?: string;
  /** Location as stated by the alert (advisory: it may be IP-derived or attacker-supplied). */
  location?: string;
  ip_addresses: string[];
  device?: string;
  /** Masked (`j***@e***.com`); omitted when masking is uncertain. */
  account_hint?: string;
  evidence: { field: "subject" | "sender" | "body"; excerpt: string }[];
  warnings: string[];
  analyzed_at: string;
  /** Set by analyzeEmail from the full text (first 200k chars) or a mailto: link that asks for a code. */
  reply_with_code?: true;
  /** Number of mailto: links in the message (set by analyzeEmail when above zero). */
  mailto_links?: number;
};

export type SigninFakeRule = "sender_provider_mismatch" | "off_provider_link" | "callback_number" | "reply_with_code";
