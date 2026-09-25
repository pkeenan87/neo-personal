import type { UrlAnalysis } from "../types.js";

/** `user_country` is ISO 3166-1 alpha-2 (default "US"). */
export type SmsInput = { sender?: string; body: string; received_at?: string; user_country?: string };

export type SmsSenderKind = "short_code" | "ten_digit" | "toll_free" | "international" | "email_to_sms" | "alphanumeric" | "unknown";

export type SmsAnalysis = {
  sender: {
    raw?: string;
    kind: SmsSenderKind;
    e164?: string;
    country?: string;
    email_domain?: string;
    /** Brand the body claims to be from (USPS, a bank, E-ZPass...), whatever the sender kind. */
    claims_brand?: string;
  };
  urls: { url: string; analysis?: UrlAnalysis; skipped?: "limit" | "duplicate" | "unsupported_scheme" }[];
  /** Callback numbers in the body (E.164 where parseable), excluding the sender. */
  phone_numbers: string[];
  signals: string[];
  heuristics: string[];
  body_excerpt: string;
  errors: string[];
  analyzed_at: string;
  mock?: true;
};
