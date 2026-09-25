# Spec for SMS Analysis

branch: claude/feature/sms-analysis

## Summary

`analyze_sms` in `packages/tools`: given a pasted text message (or a transcription the model made from a screenshot), classify the sender, detect lure templates and callback-number scams, and run every URL through `analyzeUrl`. Claude produces the `Verdict` (subject_type `sms`). Smishing is mostly about the link and the sender type, so this tool is thin on purpose; the shared URL pipeline does the heavy work.

## Functional requirements

```ts
export function analyzeSms(input: SmsInput, opts?: { deps?: Partial<UrlAnalysisDeps>; signal?: AbortSignal }): Promise<SmsAnalysis>;
export const analyzeSmsTool: RegisteredTool;               // name "analyze_sms"
export function createAnalyzeSmsTool(opts: { deps?: Partial<UrlAnalysisDeps> }): RegisteredTool;
export const SMS_ANALYSIS_GUIDANCE: string;
export function extractSmsIocs(a: SmsAnalysis): Verdict["iocs"];
export type SmsInput = { sender?: string; body: string; received_at?: string; user_country?: string };  // ISO 3166-1 alpha-2, default "US"
```

Tool input schema (`strict: true`): `{ sender?: string; body: string (max 4000); received_at?: string; user_country?: string }`.

`SmsAnalysis`
```ts
{
  sender: {
    raw?: string;
    kind: "short_code" | "ten_digit" | "toll_free" | "international" | "email_to_sms" | "alphanumeric" | "unknown";
    e164?: string; country?: string;                    // libphonenumber-style parse without the dependency: use a small bundled table of country codes + US/CA NANP rules
    email_domain?: string;                              // for email_to_sms
    claims_brand?: string;                              // body claims to be USPS/bank/etc. while sender is a personal number
  };
  urls: { url: string; analysis?: UrlAnalysis; skipped?: "limit" | "duplicate" | "unsupported_scheme" }[];   // max 5
  phone_numbers: string[];                              // callback numbers found in the body (E.164 where parseable)
  signals: string[];
  heuristics: string[];
  body_excerpt: string;                                 // ≤ 1000 chars
  errors: string[];
  analyzed_at: string;
  mock?: true;
}
```

Signals (stable codes): `delivery_lure` (USPS/UPS/FedEx/DHL/Royal Mail/Canada Post redelivery, customs fee), `toll_lure` (E-ZPass, FasTrak, SunPass, toll authority), `bank_fraud_alert_lure`, `tax_or_government_lure`, `prize_lure`, `job_offer_lure`, `wrong_number_opener` (pig butchering: friendly misdirected message with no business purpose), `account_verification_lure`, `family_emergency_lure` ("Mom, I lost my phone"), `two_factor_code_request` (asks the user to share a code), `urgency_language`, `callback_number_present`, `reply_stop_bait`, `url_shortener`, `bare_ip_url`, `unusual_tld`, `brand_claim_from_personal_number`, `brand_claim_from_international_number`, `link_domain_not_brand` (message claims brand X but URL registrable is not X's; use the Phase 0 brand list), `imessage_from_email` (sender is an email address on iMessage, common for smishing), `injection_attempt_in_content`.

Rules
- URL extraction tolerates missing scheme (`usps-redelivery.com/track`), obfuscation (`hxxp`, `[.]`), and trailing punctuation.
- Sender kinds: 5–6 digits = `short_code` (legitimate for brands, but spoofable); NANP 10/11 digits = `ten_digit` (or `toll_free` for 800/888/877/866/855/844/833); `+` with non-user country = `international`; contains `@` = `email_to_sms`; letters = `alphanumeric` (common outside NANP).
- `brand_claim_*`: the body mentions a brand from the list and the sender is `ten_digit` or `international` or `email_to_sms`.
- Callback numbers: NANP and international patterns, excluding the sender itself; reported as IOCs `phone_numbers`.
- Mock mode: same as email; URL analysis uses the Phase 0 mock, no network.

## Possible Edge Cases

- Body with only a link and no text: analysis rests on the URL; signals empty; guidance says a bare link from an unknown number is itself a warning.
- Legitimate short-code bank alert with no URL: should not fire `bank_fraud_alert_lure` alone into a malicious verdict; the guidance frames it as "verify through the app or the number on your card".
- Group texts / RCS with multiple senders: `sender` may be a list; take the first, note `group_message`.
- Non-Latin script bodies: signals are keyword-based in English plus Spanish for delivery/toll/bank lures; otherwise rely on URL evidence and say so (`non_english_body`).
- Screenshot transcription passed as `body` may include UI chrome ("Delivered", timestamps): strip common iOS/Android chrome lines.

## Acceptance Criteria

- Fixture messages (USPS redelivery smish, toll smish, wrong-number opener, legit 2FA code from short code, legit delivery notice from carrier short code with brand-domain link, family emergency) yield the expected sender kind and signal set.
- No network in tests; `deps` injection.
- Output bounded (≤ 5 URLs, ≤ 10 phone numbers, excerpt ≤ 1000).

## Open Questions

- Country-specific lure keywords beyond US/CA/UK/AU; keep the keyword table in `packages/tools/src/data/sms-lures.json` so it can grow without code changes.

## Testing Guidelines
Create `packages/tools/test/sms.test.ts`: sender classification table test; signal detection per fixture; URL extraction with obfuscation; callback-number extraction; tool wrapper schema validation.
