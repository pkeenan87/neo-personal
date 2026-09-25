import { domainToASCII } from "node:url";
import { logger } from "@neo/core";
import freeMail from "../data/free-mail-providers.json" with { type: "json" };
import { analyzeUrl } from "../analyzeUrl.js";
import { brandOwnsDomain, findBrandInText } from "../brandText.js";
import { detectLookalike } from "../checks/lookalike.js";
import { resolveDeps } from "../deps.js";
import { MOCK_ANALYZED_AT } from "../mock.js";
import { extractPhoneNumbers, parsePhone } from "../phone.js";
import { emailContentSignals, looksLikeInjection } from "../signals.js";
import { boundStrings, clamp, cleanLine, hasUnicodeTricks, normalizeForMatch, stripInvisible } from "../text.js";
import type { CheckContext, UrlAnalysisDeps } from "../types.js";
import { analyzeAttachments } from "./attachments.js";
import { authHeuristics, evaluateAuthentication, registrableDomain } from "./auth.js";
import { EMAIL_CONTENT_SIGNALS, EMAIL_HEURISTIC_CODES, orderCodes } from "./codes.js";
import { analyzeHtml, type HtmlFacts } from "./html.js";
import { EmailParseError, isOle, parseEmail, parsePasted, toBytes } from "./parse.js";
import type { EmailAnalysis, EmailAuthentication, EmailInput, EmailUrlEntry, ParsedEmail } from "./types.js";
import { collectEmailUrls, MANY_URLS_THRESHOLD, MAX_LISTED_URLS } from "./urls.js";

export type AnalyzeEmailOptions = { deps?: Partial<UrlAnalysisDeps>; signal?: AbortSignal; maxUrls?: number };

export const DEFAULT_EMAIL_MAX_URLS = 8;
const HARD_MAX_URLS = 8;
const EXCERPT_CHARS = 2000;
const HIDDEN_TEXT_THRESHOLD = 200;

const FREE_MAIL_DOMAINS = new Set(freeMail.domains);
const FREE_MAIL_LABELS = new Set(freeMail.labels_any_suffix);

export function isFreeMailDomain(registrable: string | undefined): boolean {
  if (!registrable) return false;
  if (FREE_MAIL_DOMAINS.has(registrable)) return true;
  return FREE_MAIL_LABELS.has(registrable.split(".")[0] ?? "");
}

/** Header names that mark input as an RFC 5322 message rather than plain text. */
const MESSAGE_HEADERS = ["from", "to", "subject", "date", "received", "message-id", "mime-version", "return-path", "authentication-results", "dkim-signature"];

const ABSENT_AUTH: EmailAuthentication = { spf: "absent", dkim: "absent", dkim_domains: [], dmarc: "absent", aligned: null, source: "none" };

function emptyAnalysis(inputKind: EmailAnalysis["input_kind"], analyzedAt: string, mock: boolean, errors: string[]): EmailAnalysis {
  const a: EmailAnalysis = {
    input_kind: inputKind,
    forwarded: false,
    headers_present: false,
    sender: {
      from: {},
      reply_to: [],
      display_name_looks_like_address: false,
      from_domain_lookalike: null,
      reply_to_divergent: false,
      return_path_divergent: false,
      free_mail_provider: false,
    },
    authentication: { ...ABSENT_AUTH, dkim_domains: [] },
    received_hops: 0,
    urls: [],
    attachments: [],
    phone_numbers: [],
    content: {
      text_excerpt: "",
      signals: [],
      html: { present: false, hidden_text: false, forms: 0, external_images: 0, tracking_pixels: 0, mismatched_link_text: 0, scripts: 0 },
    },
    heuristics: [],
    errors,
    analyzed_at: analyzedAt,
  };
  if (mock) a.mock = true;
  return a;
}

/** Error-only result (unknown artifact, unsupported input) in the EmailAnalysis shape. */
export function emailErrorResult(errors: string[], opts: { inputKind?: EmailAnalysis["input_kind"]; deps?: Partial<UrlAnalysisDeps> } = {}): EmailAnalysis {
  const deps = resolveDeps(opts.deps);
  return emptyAnalysis(opts.inputKind ?? "raw", deps.mock ? MOCK_ANALYZED_AT : deps.now().toISOString(), deps.mock, errors);
}

function domainOfAddress(address: string | undefined): string | undefined {
  if (!address || !address.includes("@")) return undefined;
  const raw = address.slice(address.lastIndexOf("@") + 1).replace(/[<>\s[\]]/g, "").replace(/\.$/, "").toLowerCase();
  if (!raw) return undefined;
  return domainToASCII(raw) || raw;
}

/** URLs in excerpts: keep the origin, drop long tracking paths. */
function tidyExcerpt(text: string): string {
  const cleaned = stripInvisible(text)
    .replace(/https?:\/\/[^\s<>"')\]]{80,}/g, (u) => {
      try {
        return `${new URL(u).origin}/\u2026`;
      } catch {
        return clamp(u, 80);
      }
    })
    .replace(/[ \t\u00A0]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return clamp(cleaned, EXCERPT_CHARS);
}

/** Pick the message to analyze: the inner message of a forward (recursing once), or the message itself. */
function selectTarget(parsed: ParsedEmail): { target: ParsedEmail; forwarded: boolean; wrapperOnly: boolean } {
  const w = parsed.forwardedWrapper;
  if (!w) return { target: parsed, forwarded: false, wrapperOnly: false };
  if (!w.inner) return { target: parsed, forwarded: true, wrapperOnly: true };
  let target = w.inner;
  let wrapperOnly = w.detectedBy !== "attached_eml";
  const w2 = target.forwardedWrapper;
  if (w2?.inner) {
    target = w2.inner;
    if (w2.detectedBy !== "attached_eml") wrapperOnly = true;
  }
  return { target, forwarded: true, wrapperOnly };
}

type SenderResult = { sender: EmailAnalysis["sender"]; heuristics: string[]; fromRegistrable?: string };

function analyzeSender(p: ParsedEmail, deps: UrlAnalysisDeps, knownSender: boolean): SenderResult {
  const heuristics: string[] = [];
  const sender: EmailAnalysis["sender"] = {
    from: {},
    reply_to: [],
    display_name_looks_like_address: false,
    from_domain_lookalike: null,
    reply_to_divergent: false,
    return_path_divergent: false,
    free_mail_provider: false,
  };
  if (!knownSender) return { sender, heuristics };

  const address = p.from?.address ? cleanLine(p.from.address, 320) : undefined;
  const domain = domainOfAddress(address);
  const registrable = registrableDomain(domain);
  const rawName = p.from?.name ?? "";
  const displayName = cleanLine(rawName, 200);
  if (address) sender.from.address = address;
  if (displayName) sender.from.display_name = displayName;
  if (domain) sender.from.domain = domain;
  if (registrable) sender.from.registrable = registrable;

  if (!address) heuristics.push("missing_from");
  if (p.fromCount > 1) heuristics.push("multiple_from");
  if (rawName && hasUnicodeTricks(rawName)) heuristics.push("unicode_tricks_in_display_name");

  const nameAddress = /[^\s@<>"'()]+@([^\s@<>"'()]+\.[a-z]{2,})/i.exec(displayName);
  sender.display_name_looks_like_address = !!nameAddress;
  if (nameAddress && registrable && registrableDomain(nameAddress[1]!.toLowerCase()) !== registrable) heuristics.push("display_name_address_mismatch");

  const brand = displayName ? findBrandInText(displayName, deps.brands, { lookalike: true }) : undefined;
  const brandBacked = brand ? brandOwnsDomain(brand, domain) : false;
  if (brand) sender.display_name_brand = brand.name;
  if (brand && !brandBacked) heuristics.push("spoofed_brand_in_display_name");

  const lookalike = domain ? detectLookalike(domain, deps.brands) : null;
  sender.from_domain_lookalike = lookalike ? { brand: lookalike.brand, technique: lookalike.technique } : null;
  if (lookalike) heuristics.push("lookalike_sender_domain");

  sender.free_mail_provider = isFreeMailDomain(registrable);
  if (sender.free_mail_provider && brand && !brandBacked) heuristics.push("free_mail_sender_claiming_brand");

  for (const r of p.replyTo.slice(0, 10)) {
    if (!r.address) continue;
    const d = domainOfAddress(r.address);
    const entry: { address: string; domain?: string } = { address: cleanLine(r.address, 320) };
    if (d) entry.domain = d;
    sender.reply_to.push(entry);
    const reg = registrableDomain(d);
    if (registrable && reg && reg !== registrable) sender.reply_to_divergent = true;
  }
  if (sender.reply_to_divergent) heuristics.push("reply_to_divergent");

  if (p.returnPath) {
    const rp = cleanLine(p.returnPath, 320);
    const d = domainOfAddress(rp);
    sender.return_path = { address: rp };
    if (d) sender.return_path.domain = d;
    const reg = registrableDomain(d);
    if (registrable && reg && reg !== registrable) {
      sender.return_path_divergent = true;
      heuristics.push("return_path_divergent");
    }
  }
  return { sender, heuristics, ...(registrable ? { fromRegistrable: registrable } : {}) };
}

function htmlSummary(facts: HtmlFacts | undefined, mismatches: number, hiddenInjection: boolean): EmailAnalysis["content"]["html"] {
  if (!facts) return { present: false, hidden_text: false, forms: 0, external_images: 0, tracking_pixels: 0, mismatched_link_text: 0, scripts: 0 };
  const external = facts.images.filter((i) => /^https?:/i.test(i.src));
  return {
    present: true,
    hidden_text: facts.hidden_text.length >= HIDDEN_TEXT_THRESHOLD || hiddenInjection,
    forms: facts.forms,
    external_images: external.length,
    tracking_pixels: external.filter((i) => i.pixel).length,
    mismatched_link_text: mismatches,
    scripts: facts.scripts,
  };
}

/**
 * Analyze an email (raw RFC 5322 bytes or a pasted body) into structured
 * evidence. Never throws for hostile or malformed input: problems are listed
 * in `errors`. Links go through `analyzeUrl` (at most `maxUrls`, default 8);
 * attachments are triaged by type and hash only, never opened or uploaded.
 */
export async function analyzeEmail(input: EmailInput, opts: AnalyzeEmailOptions = {}): Promise<EmailAnalysis> {
  const started = Date.now();
  const deps = resolveDeps(opts.deps);
  const analyzedAt = deps.mock ? MOCK_ANALYZED_AT : deps.now().toISOString();
  const maxUrls = Math.max(0, Math.min(HARD_MAX_URLS, Math.floor(opts.maxUrls ?? DEFAULT_EMAIL_MAX_URLS)));
  const inputKind: EmailAnalysis["input_kind"] = "raw" in input ? "raw" : "pasted";
  const errors: string[] = [];

  let parsed: ParsedEmail;
  if ("raw" in input) {
    const bytes = toBytes(input.raw);
    if (!bytes.length) return emptyAnalysis(inputKind, analyzedAt, deps.mock, ["empty_input"]);
    if (isOle(bytes)) return emptyAnalysis(inputKind, analyzedAt, deps.mock, ["unsupported_format"]);
    try {
      parsed = await parseEmail(bytes);
    } catch (e) {
      const code = e instanceof EmailParseError ? e.code : "parse_failed";
      return emptyAnalysis(inputKind, analyzedAt, deps.mock, [code]);
    }
    // Plain text (a .txt artifact, a paste without headers) is not a MIME message: read it as a pasted body.
    const names = new Set(parsed.headers.map((h) => h.name.toLowerCase()));
    if (!MESSAGE_HEADERS.some((n) => names.has(n))) parsed = parsePasted({ body: new TextDecoder().decode(bytes) });
  } else {
    parsed = parsePasted(input.pasted);
  }

  const { target, forwarded, wrapperOnly } = selectTarget(parsed);
  const knownSender = !(forwarded && target === parsed);
  const headersPresent = inputKind === "raw" && !target.headersSynthetic && knownSender;
  if (parsed.truncated || target.truncated) errors.push("truncated: message or HTML exceeded the parse cap");

  const heuristics = new Set<string>();
  if (wrapperOnly) heuristics.add("forwarded_wrapper_only");

  // Sender and authentication.
  const senderResult = analyzeSender(target, deps, knownSender);
  for (const h of senderResult.heuristics) heuristics.add(h);
  const authentication = headersPresent ? evaluateAuthentication(target.headers, senderResult.fromRegistrable) : { ...ABSENT_AUTH, dkim_domains: [] };
  for (const h of authHeuristics(authentication, senderResult.fromRegistrable, headersPresent)) heuristics.add(h);
  const receivedHops = headersPresent ? target.headers.filter((h) => h.name.toLowerCase() === "received").length : 0;

  // Body.
  const html = target.html ? analyzeHtml(target.html) : undefined;
  const bodyText = target.text?.trim() ? target.text : (html?.text ?? "");
  const subject = target.subject ? cleanLine(target.subject, 500) : undefined;
  const matchText = normalizeForMatch(`${subject ?? ""}\n${bodyText}`);
  const signals = new Set(emailContentSignals(matchText));
  const hiddenInjection = !!html?.hidden_text && looksLikeInjection(normalizeForMatch(html.hidden_text));
  if (looksLikeInjection(matchText) || hiddenInjection) signals.add("injection_attempt_in_content");

  // Links.
  const collected = collectEmailUrls({ ...(html ? { html } : {}), text: target.text ?? "" });
  const ctx: CheckContext = { deps, ...(opts.signal ? { signal: opts.signal } : {}) };
  const listed = collected.candidates.slice(0, MAX_LISTED_URLS);
  let analyzedCount = 0;
  const urls: EmailUrlEntry[] = await Promise.all(
    listed.map(async (c): Promise<EmailUrlEntry> => {
      const entry: EmailUrlEntry = { url: c.url, text_mismatch: c.text_mismatch };
      if (c.display_text) entry.display_text = c.display_text;
      if (c.skipped) {
        entry.skipped = c.skipped;
        return entry;
      }
      if (analyzedCount >= maxUrls) {
        entry.skipped = "limit";
        return entry;
      }
      analyzedCount++;
      entry.analysis = await analyzeUrl(c.url, { deps, ...(ctx.signal ? { signal: ctx.signal } : {}) });
      return entry;
    }),
  );
  if (collected.mismatches > 0) heuristics.add("link_text_mismatch");
  if (collected.unique_http > MANY_URLS_THRESHOLD) heuristics.add("many_urls");
  if (urls.some((u) => u.skipped === "unsupported_scheme")) heuristics.add("url_non_web_scheme");
  for (const u of urls) {
    const h = u.analysis?.heuristics ?? [];
    if (h.includes("young_domain")) heuristics.add("first_seen_domain_lt_30d");
    if (h.some((x) => x === "safe_browsing_match" || x === "virustotal_malicious" || x === "urlscan_malicious")) heuristics.add("url_reputation_flagged");
    if (h.includes("brand_lookalike")) heuristics.add("url_brand_lookalike");
  }

  // Callback numbers (URLs and addresses removed first so their digits are not read as phone numbers).
  const phoneText = bodyText.replace(/\bhttps?:\/\/\S+/gi, " ").replace(/\S+@\S+/g, " ");
  const phones = new Set(extractPhoneNumbers(phoneText, { max: 10 }));
  for (const t of collected.tel_numbers) phones.add(parsePhone(t)?.e164 ?? t);
  const phone_numbers = [...phones].slice(0, 10);
  if (phone_numbers.length && (signals.has("callback_context") || collected.tel_numbers.length)) signals.add("callback_number_present");
  signals.delete("callback_context");

  // Attachments.
  const att = await analyzeAttachments(target.attachments, ctx, errors);
  for (const h of att.heuristics) heuristics.add(h);

  const htmlInfo = htmlSummary(html, collected.mismatches, hiddenInjection);
  if (htmlInfo.hidden_text) heuristics.add("hidden_html_text");
  if (htmlInfo.forms > 0) heuristics.add("html_form");
  for (const s of signals) heuristics.add(s);

  const result: EmailAnalysis = {
    input_kind: inputKind,
    forwarded,
    headers_present: headersPresent,
    sender: senderResult.sender,
    authentication,
    received_hops: receivedHops,
    urls,
    attachments: att.attachments,
    phone_numbers,
    content: {
      ...(subject ? { subject } : {}),
      text_excerpt: tidyExcerpt(bodyText),
      signals: orderCodes([...signals].filter((s) => EMAIL_CONTENT_SIGNALS.has(s)), EMAIL_HEURISTIC_CODES),
      html: htmlInfo,
    },
    heuristics: orderCodes(heuristics, EMAIL_HEURISTIC_CODES),
    errors,
    analyzed_at: analyzedAt,
  };
  if (deps.mock) result.mock = true;

  logger.info(
    `email analyzed: spf=${authentication.spf} dkim=${authentication.dkim} dmarc=${authentication.dmarc} urls=${urls.length} analyzed=${analyzedCount} attachments=${att.attachments.length} forwarded=${forwarded}`,
    "tools.email",
    { toolName: "analyze_email", durationMs: Date.now() - started, labels: result.heuristics },
  );
  return boundStrings(result, 2048);
}
