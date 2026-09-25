/** Stable heuristic codes emitted in `EmailAnalysis.heuristics` (content codes also appear in `content.signals`). */
export const EMAIL_HEURISTIC_CODES = {
  // sender
  missing_from: "No From address",
  multiple_from: "More than one From address or header",
  unicode_tricks_in_display_name: "Display name contains bidi-override, zero-width, or control characters",
  spoofed_brand_in_display_name: "Display name claims a brand the From domain does not belong to",
  display_name_address_mismatch: "Display name contains an email address on a different domain than the real From",
  free_mail_sender_claiming_brand: "Free-mail sender (gmail.com, outlook.com, ...) whose display name claims a brand",
  lookalike_sender_domain: "From domain imitates a known brand",
  reply_to_divergent: "Reply-To registrable domain differs from From",
  return_path_divergent: "Return-Path (bounce) registrable domain differs from From",
  // authentication
  spf_fail: "SPF failed (hard fail)",
  spf_softfail: "SPF soft-failed (~all)",
  dkim_fail: "DKIM signature failed verification",
  dmarc_fail: "DMARC failed",
  auth_absent: "Headers present but no authentication results or signatures (not a failure by itself)",
  unaligned_dkim: "DKIM passed only for a domain unrelated to the From domain",
  // forwarding
  forwarded_wrapper_only: "Analyzed a forwarded copy whose original headers were lost; sender authentication is unknown",
  // links
  link_text_mismatch: "Visible link text shows one domain but the link goes to another",
  first_seen_domain_lt_30d: "A linked domain was registered less than 30 days ago",
  url_reputation_flagged: "A linked URL is flagged by Safe Browsing, VirusTotal, or urlscan",
  url_brand_lookalike: "A linked domain imitates a known brand",
  url_non_web_scheme: "A link uses a non-web scheme (javascript:, data:, ms-*, search-ms:, ...)",
  many_urls: "More than 25 distinct links (only the highest-priority ones were analyzed)",
  // html
  hidden_html_text: "HTML hides a substantial amount of text (or hidden text addresses an AI)",
  html_form: "HTML contains a form (credentials can be posted from inside the email)",
  // attachments
  dangerous_attachment_type: "Executable, script, disk image, HTML/SVG, or macro-enabled attachment",
  extension_mismatch: "Attachment content type disagrees with its extension",
  double_extension: "Attachment name hides its real extension (invoice.pdf.exe, RTLO)",
  ole_document: "Legacy Office/OLE attachment (macros cannot be ruled out)",
  archive_not_inspected: "Archive attachment whose contents were not inspected",
  attachment_vt_flagged: "VirusTotal engines flag an attachment hash",
  // content
  urgency_language: "Pressure to act quickly",
  credential_request: "Asks to sign in, verify, or re-enter credentials",
  payment_request: "Asks to pay or update payment details",
  gift_card_request: "Asks to buy gift cards or send card codes",
  wire_or_crypto_request: "Asks for a wire transfer, new bank details, or cryptocurrency",
  invoice_or_po: "Invoice, purchase order, or remittance theme",
  account_suspension_lure: "Threatens account suspension or reports unusual activity",
  delivery_lure: "Package delivery problem or fee",
  tax_or_government_lure: "Tax, government, court, or benefits theme",
  prize_lure: "Prize, reward, or winnings",
  job_offer_lure: "Unsolicited job or easy-money offer",
  romance_or_wrong_number: "Romance or wrong-number opener",
  qr_code_mentioned: "Asks to scan a QR code (moves the link off the protected device)",
  generic_greeting: "Generic greeting (Dear Customer)",
  callback_number_present: "Asks the reader to call a phone number (callback phishing)",
  injection_attempt_in_content: "Content addresses an AI/assistant or tries to override instructions",
} as const;

export type EmailHeuristicCode = keyof typeof EMAIL_HEURISTIC_CODES;

export const EMAIL_CONTENT_SIGNALS = new Set<string>([
  "urgency_language", "credential_request", "payment_request", "gift_card_request", "wire_or_crypto_request", "invoice_or_po",
  "account_suspension_lure", "delivery_lure", "tax_or_government_lure", "prize_lure", "job_offer_lure", "romance_or_wrong_number",
  "qr_code_mentioned", "generic_greeting", "callback_number_present", "injection_attempt_in_content",
]);

export function orderCodes(codes: Iterable<string>, catalog: Record<string, string>): string[] {
  const order = Object.keys(catalog);
  const idx = (c: string) => {
    const i = order.indexOf(c);
    return i === -1 ? order.length : i;
  };
  return [...new Set(codes)].sort((a, b) => idx(a) - idx(b) || a.localeCompare(b));
}
