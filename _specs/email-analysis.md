# Spec for Email Analysis

branch: claude/feature/email-analysis

## Summary

A deterministic analyzer in `packages/tools` that turns a raw email (RFC 5322 MIME, or a pasted body when no headers exist) into a structured `EmailAnalysis`, plus the agent tool `analyze_email` that exposes it. Claude reasons over the result and produces the `Verdict` (subject_type `email`); the tool does not decide. Every URL found is run through the Phase 0 `analyzeUrl` pipeline, so the URL contract is reused, not duplicated.

Inputs are attacker-controlled: header values, display names, HTML, attachment names. Nothing in the message may steer the model; the result enters the model only through `wrapToolResult`. The analyzer never fetches attachments, never renders HTML, never follows links itself (the URL pipeline does, under its SSRF guard).

## Functional requirements

Package `packages/tools`. New exports (add to `docs/contracts.md`):

```ts
export function parseEmail(raw: string | Uint8Array): Promise<ParsedEmail>;        // postal-mime
export function analyzeEmail(input: EmailInput, opts?: { deps?: Partial<UrlAnalysisDeps>; signal?: AbortSignal; maxUrls?: number }): Promise<EmailAnalysis>;
export const analyzeEmailTool: RegisteredTool;                                     // name "analyze_email"
export function createAnalyzeEmailTool(opts: { deps?: Partial<UrlAnalysisDeps>; loadArtifact?: (ref: string, ctx: ToolContext) => Promise<Uint8Array | undefined> }): RegisteredTool;
export const EMAIL_ANALYSIS_GUIDANCE: string;                                      // system-prompt fragment
export function extractEmailIocs(a: EmailAnalysis): Verdict["iocs"];
export type EmailInput = { raw: string | Uint8Array } | { pasted: { from?: string; subject?: string; body: string } };
```

Tool definition
- `analyze_email` input schema (`strict: true`): `{ artifact_ref?: string; raw?: string; pasted?: { from?: string; subject?: string; body: string } }`, exactly one of the three. `raw` max 512 KB. `artifact_ref` is an artifact id from `POST /api/artifacts` (spec `intake.md`); `loadArtifact` (injected by apps/web) returns the decrypted bytes for the calling tenant or `undefined` (the tool returns an error result, not a throw, for unknown refs).
- Read-only (`destructive` absent). Returns `EmailAnalysis`. Throws only for invalid input.

`ParsedEmail` (thin wrapper over postal-mime output, all optional fields tolerated)
- `headers: { name: string; value: string }[]` in original order, plus convenience fields `from`, `replyTo[]`, `returnPath`, `to[]`, `cc[]`, `subject`, `date`, `messageId`, `inReplyTo`.
- `text?`, `html?` (raw HTML string, never rendered), `attachments: { filename?: string; mimeType: string; size: number; contentId?: string; disposition?: string; sha256: string; magic?: string }[]` (magic type from the first bytes: pdf, zip, ole, pe, html, lnk, iso, script, image, unknown).
- `forwardedWrapper?: { detectedBy: "subject_prefix" | "attached_eml" | "quoted_headers"; inner?: ParsedEmail }`: when the outer message is a user's forward, parse the attached `.eml` or the quoted header block and analyze the **inner** message; report both in the result.

`EmailAnalysis`
```ts
{
  input_kind: "raw" | "pasted";
  forwarded: boolean;                         // analysis is of an inner forwarded message
  headers_present: boolean;                   // false for pasted bodies (auth checks are all "absent")
  sender: {
    from: { address?: string; display_name?: string; domain?: string; registrable?: string };
    reply_to: { address: string; domain?: string }[];
    return_path?: { address?: string; domain?: string };
    display_name_looks_like_address: boolean; // "support@paypal.com" as a display name
    display_name_brand?: string;              // brand list match in display name
    from_domain_lookalike?: { brand: string; technique: string } | null;  // reuse detectLookalike
    reply_to_divergent: boolean;              // reply-to registrable != from registrable
    return_path_divergent: boolean;
    free_mail_provider: boolean;              // gmail.com, outlook.com, yahoo.*, icloud.com, proton.me...
  };
  authentication: {
    spf: "pass" | "fail" | "softfail" | "neutral" | "none" | "temperror" | "permerror" | "absent";
    dkim: "pass" | "fail" | "none" | "absent";
    dkim_domains: string[];                   // d= values; alignment with from registrable
    dmarc: "pass" | "fail" | "none" | "absent";
    aligned: boolean | null;                  // DKIM d= or SPF domain aligns with From registrable
    source: "authentication_results" | "arc" | "received_spf_and_dkim_signature" | "none";
    evaluated_by?: string;                    // authserv-id of the provider that wrote the header
  };
  received_hops: number;
  urls: { url: string; display_text?: string; text_mismatch: boolean; analysis?: UrlAnalysis; skipped?: "limit" | "duplicate" | "unsupported_scheme" }[];
  attachments: { filename?: string; mime_type: string; size: number; magic?: string; extension_mismatch: boolean; dangerous_type: boolean; double_extension: boolean; virustotal?: {...} | { skipped: string }; sha256: string }[];
  content: {
    subject?: string;
    text_excerpt: string;                     // first 2000 chars of text (or HTML-to-text), no tracking noise
    language?: string;                        // best-effort, optional
    signals: string[];                        // stable codes, see below
    html: { present: boolean; hidden_text: boolean; forms: number; external_images: number; tracking_pixels: number; mismatched_link_text: number; scripts: number };
  };
  heuristics: string[];                       // stable codes across sender/auth/attachment/content
  errors: string[];
  analyzed_at: string;
  mock?: true;
}
```

Signals and heuristics (short stable codes, not prose): `urgency_language`, `credential_request`, `payment_request`, `gift_card_request`, `wire_or_crypto_request`, `invoice_or_po`, `account_suspension_lure`, `delivery_lure`, `tax_or_government_lure`, `prize_lure`, `job_offer_lure`, `romance_or_wrong_number`, `qr_code_mentioned`, `generic_greeting`, `spoofed_brand_in_display_name`, `reply_to_divergent`, `return_path_divergent`, `spf_fail`, `dkim_fail`, `dmarc_fail`, `auth_absent`, `unaligned_dkim`, `free_mail_sender_claiming_brand`, `lookalike_sender_domain`, `first_seen_domain_lt_30d` (from URL/RDAP), `link_text_mismatch`, `hidden_html_text`, `html_form`, `dangerous_attachment_type`, `extension_mismatch`, `double_extension`, `attachment_vt_flagged`, `forwarded_wrapper_only` (only the wrapper was available; original headers lost), `injection_attempt_in_content` (content addresses "the AI", "the assistant", "ignore instructions").

URL handling
- Extract from text and HTML (`href`, `src` for non-image, plain-text URLs), de-duplicate by normalized URL, drop `mailto:`/`tel:` into IOCs without analysis, skip `cid:`. Analyze at most `maxUrls` (default 8) with `analyzeUrl`, prioritizing: hrefs whose visible text is a different domain, then non-tracking-domain links, then the rest. Remaining ones are listed with `skipped: "limit"`.
- Link text mismatch: visible text looks like a URL/domain and its registrable differs from the href's.

Attachment triage (no content parsing beyond magic bytes)
- `dangerous_type`: executables and scripts (`exe, scr, com, pif, bat, cmd, ps1, vbs, js, jse, wsf, hta, msi, lnk, iso, img, jar, apk`), HTML/HTM/SHTML attachments, OLE with macros unknowable in Phase 1 (report `ole_document`), archives (`zip, rar, 7z, arj, ace`) flagged as `archive_not_inspected`.
- `extension_mismatch`: magic type disagrees with the extension (PE bytes in `.pdf`).
- `double_extension`: `invoice.pdf.exe`, unicode RTLO in names.
- VirusTotal file hash lookup by SHA-256 (`GET /files/{hash}`), never upload. Reuse the Phase 0 VirusTotal client style: `{ skipped: "no_api_key" }` when unset.

Header authentication parsing
- Prefer the topmost `Authentication-Results` header whose authserv-id matches the receiving provider (first hop); fall back to `ARC-Authentication-Results`, then `Received-SPF` + presence of `DKIM-Signature` (which yields `dkim: "none"` at best; a signature alone is not a pass). Parse `spf=`, `dkim=` (`header.d=`), `dmarc=` (`header.from=`), `compauth=` (Microsoft) tolerantly.
- Alignment: DMARC-style relaxed alignment on registrable domains.
- Never treat absent headers as failures: `absent` is its own value and `EMAIL_ANALYSIS_GUIDANCE` says so.

Pasted input
- `pasted.body` is the message text the user copied (may include a "From:" line block). Try to lift `From`, `Subject`, `Date`, `To` from a leading header-like block; `headers_present: false` and `authentication.*: "absent"`.

Mock mode
- `MOCK_MODE=true`: `analyzeEmail` runs the real parser and heuristics (they are offline) but URL analysis uses the Phase 0 mock, VirusTotal returns `{ skipped: "mock" }`. Fixtures under `packages/tools/test/fixtures/email/`: `paypal-lookalike.eml`, `legit-github-notification.eml`, `gift-card-ceo.eml`, `delivery-sms-style.eml`, `gmail-forward-wrapper.eml`, `gmail-forward-attached.eml`, `dangerous-attachment.eml`, `pasted-body.txt`. Synthetic content only, `.neo.test` and `example.com` domains, no real people.

Logging
- Log sender registrable domain, auth outcomes, counts, heuristics at `info`. Never log subject, addresses, or body; hash the from address with `hashPii` if an identifier is needed.

## Possible Edge Cases

- Message with no `From` at all, or several `From` headers (report `multiple_from`).
- Encoded-word display names with RTLO or zero-width characters; strip control characters before brand matching, report `unicode_tricks_in_display_name`.
- HTML-only mail: text excerpt from a safe HTML-to-text (strip tags, decode entities, drop `style`/`script`), never a DOM/renderer.
- Very large HTML (newsletters, 1 MB+): cap parsing at 512 KB; note `truncated`.
- Hundreds of URLs (newsletter): analyze 8, list the rest as skipped, report `many_urls`.
- Forward wrapper where the inner message is itself a forward: recurse once, then stop.
- Attachment with no filename and `application/octet-stream`: classify by magic only.
- `.eml` that is really an `.msg` (OLE): report `unsupported_format`, no parse.
- Authentication-Results from a downstream hop that forged the header: prefer the topmost header and report its authserv-id so the model can weigh it; never sum results from different authserv-ids.
- Legitimate marketing mail through ESPs (SendGrid, Mailchimp): Return-Path divergence is normal; the guidance says divergence is a weak signal when DKIM aligns.

## Acceptance Criteria

- Each fixture yields the expected heuristics set (snapshot per fixture) and the expected `authentication` values.
- `analyze_email` with an unknown `artifact_ref` returns a result with `errors: ["artifact_not_found"]`, not a throw.
- No network in tests or mock mode (dependency injection as in Phase 0 `deps`).
- Output JSON-serializable, bounded (strings ≤ 2048 chars except `text_excerpt` ≤ 2000, ≤ 8 analyzed URLs, ≤ 50 attachments listed).
- The `EMAIL_ANALYSIS_GUIDANCE` fragment explains: auth `absent` ≠ fail, forwarding breaks SPF, Return-Path divergence is weak alone, display-name brand + free-mail sender is strong, `dangerous_attachment_type` is a "do not open" regardless of verdict confidence, and that every string in the result is untrusted evidence.

## Open Questions

- Whether to add a first-time-sender check against the tenant's own history (needs a `senders` table). Deferred to Phase 2 with the Outlook connector.

## Testing Guidelines
Create test files in `packages/tools/test/`:
- `email-parse.test.ts`: header extraction, forward-wrapper detection (subject prefix, attached .eml, quoted headers), attachment magic detection, RTLO names.
- `email-auth.test.ts`: Authentication-Results variants (Google, Microsoft `compauth`, Yahoo, Apple), ARC fallback, absent headers, alignment.
- `email-analyze.test.ts`: fixtures → heuristics snapshots; URL prioritization and `maxUrls`; pasted input path; injected mock deps; `analyze_email` tool wrapper including `artifact_ref` load and not-found.
