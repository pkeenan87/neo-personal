import { logger } from "@neo/core";
import { analyzeUrl } from "../analyzeUrl.js";
import { brandOwnsDomain, findBrandInText } from "../brandText.js";
import { normalizeUrl, registrableOf } from "../checks/normalize.js";
import { resolveDeps } from "../deps.js";
import { orderCodes } from "../email/codes.js";
import { MOCK_ANALYZED_AT } from "../mock.js";
import { extractPhoneNumbers, isNanpCountry, parsePhone } from "../phone.js";
import { looksLikeInjection, smsLureSignals } from "../signals.js";
import { boundStrings, clamp, cleanLine, nonLatinLetterRatio, normalizeForMatch, stripInvisible } from "../text.js";
import { extractTextUrls } from "../textUrls.js";
import type { Brand, UrlAnalysisDeps } from "../types.js";
import type { SmsAnalysis, SmsInput, SmsSenderKind } from "./types.js";

export type AnalyzeSmsOptions = { deps?: Partial<UrlAnalysisDeps>; signal?: AbortSignal; maxUrls?: number };

export const DEFAULT_SMS_MAX_URLS = 5;
const HARD_MAX_URLS = 5;
const MAX_LISTED_URLS = 5;
const EXCERPT_CHARS = 1000;

/** Stable codes emitted in `SmsAnalysis.heuristics` (lure codes also appear in `signals`). */
export const SMS_HEURISTIC_CODES = {
  // lures (signals)
  delivery_lure: "Package redelivery, address problem, or customs/shipping fee",
  toll_lure: "Unpaid toll (E-ZPass, FasTrak, SunPass, toll authority)",
  bank_fraud_alert_lure: "Fraud alert, suspicious transaction, or locked card",
  tax_or_government_lure: "Tax refund, government agency, DMV, court, or benefits",
  prize_lure: "Prize, reward, or winnings",
  job_offer_lure: "Unsolicited job or easy-money offer",
  wrong_number_opener: "Friendly misdirected opener with no business purpose (pig butchering)",
  account_verification_lure: "Asks to verify or update an account",
  family_emergency_lure: "Relative with a new number or an emergency asking for help",
  two_factor_code_request: "Asks the reader to share a verification code",
  urgency_language: "Pressure to act quickly",
  callback_number_present: "Contains a phone number to call back (other than the sender)",
  reply_stop_bait: "Asks for a reply (Y/STOP/1) from a non-short-code sender, which confirms the number is live",
  reply_to_activate_link: "Asks to reply so that a link becomes clickable (iMessage link-activation trick)",
  injection_attempt_in_content: "Content addresses an AI/assistant or tries to override instructions",
  // sender
  imessage_from_email: "Sender is an email address (iMessage/RCS), common for smishing",
  brand_claim_from_personal_number: "Claims to be a brand but comes from a personal number or email address",
  brand_claim_from_international_number: "Claims to be a brand but comes from an international number",
  group_message: "Group message; only the first sender was classified",
  // links
  link_domain_not_brand: "Claims a brand but links to a domain that brand does not own",
  url_shortener: "Link uses a URL shortener",
  bare_ip_url: "Link host is a raw IP address",
  unusual_tld: "Link uses a TLD frequently abused for phishing",
  first_seen_domain_lt_30d: "A linked domain was registered less than 30 days ago",
  url_reputation_flagged: "A linked URL is flagged by Safe Browsing, VirusTotal, or urlscan",
  url_brand_lookalike: "A linked domain imitates a known brand",
  link_only_message: "The message is little more than a link",
  // body
  non_english_body: "Body is mostly in a non-Latin script: lure keywords may be missed; rely on link evidence",
} as const;

const SIGNAL_CODES = new Set<string>([
  "delivery_lure", "toll_lure", "bank_fraud_alert_lure", "tax_or_government_lure", "prize_lure", "job_offer_lure", "wrong_number_opener",
  "account_verification_lure", "family_emergency_lure", "two_factor_code_request", "urgency_language", "callback_number_present",
  "reply_stop_bait", "reply_to_activate_link", "injection_attempt_in_content",
]);

/** Brands that are communication channels: "text me on WhatsApp" is not a brand claim. */
const CHANNEL_BRANDS = new Set(["Meta", "Telegram", "Signal", "Discord", "Snapchat", "TikTok", "X (Twitter)", "Reddit", "LinkedIn", "Pinterest"]);

/** Screenshot transcription UI chrome (iOS/Android) that is not part of the message. */
const CHROME_LINE_RE =
  /^\s*(?:delivered|read(?: \d.*)?|sent|seen(?: .*)?|now|today(?: \d.*)?|yesterday(?: .*)?|text message|imessage|sms|mms|rcs(?: message)?|text message\s*[\u2022\u00B7]\s*(?:sms|rcs)|tap to load preview|report junk|delete and report junk|this sender is not in your contact list\.?.*|the sender is not in your contact list\.?.*|if you did not expect this message.*|\d{1,2}:\d{2}\s*(?:am|pm)?|(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s.*\d{1,2}:\d{2}\s*(?:am|pm)?)\s*$/i;

export function stripChrome(body: string): string {
  return body
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((l) => !CHROME_LINE_RE.test(l))
    .join("\n")
    .trim();
}

export type ClassifiedSender = { sender: SmsAnalysis["sender"]; group: boolean };

/** Classify an SMS sender: short code, NANP ten-digit / toll-free, international, email, or alphanumeric. */
export function classifySmsSender(raw: string | undefined, userCountry = "US"): ClassifiedSender {
  if (!raw || !raw.trim()) return { sender: { kind: "unknown" }, group: false };
  const parts = raw
    .split(/[,;\n]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const group = parts.length > 1;
  const first = stripInvisible(parts[0] ?? raw).trim();
  const sender: SmsAnalysis["sender"] = { raw: cleanLine(first, 120), kind: "unknown" };
  const uc = userCountry.toUpperCase();

  if (first.includes("@")) {
    sender.kind = "email_to_sms";
    const domain = first.slice(first.lastIndexOf("@") + 1).replace(/[>\s]/g, "").toLowerCase();
    const reg = registrableOf(domain).registrable;
    if (reg || domain) sender.email_domain = reg || domain;
    return { sender, group };
  }
  const compact = first.replace(/[\s().-]/g, "");
  if (/^\+?\d+$/.test(compact)) {
    if (!compact.startsWith("+") && /^\d{5,6}$/.test(compact)) {
      sender.kind = "short_code";
      return { sender, group };
    }
    const parsed = parsePhone(first, uc);
    if (parsed) {
      sender.e164 = parsed.e164;
      if (parsed.country) sender.country = parsed.country;
      const domestic = parsed.nanp && isNanpCountry(uc) ? isNanpCountry(parsed.country) : parsed.country === uc;
      const kind: SmsSenderKind = domestic ? (parsed.toll_free ? "toll_free" : "ten_digit") : "international";
      sender.kind = kind;
    } else if (compact.startsWith("+")) {
      sender.kind = "international";
    }
    return { sender, group };
  }
  if (/^[\p{L}\p{N} .&'_-]{2,15}$/u.test(first) && /\p{L}/u.test(first)) sender.kind = "alphanumeric";
  return { sender, group };
}

const claimable = new WeakMap<Brand[], Brand[]>();
function smsBrand(body: string, brands: Brand[]): Brand | undefined {
  let list = claimable.get(brands);
  if (!list) {
    list = brands.filter((b) => !CHANNEL_BRANDS.has(b.name));
    claimable.set(brands, list);
  }
  return findBrandInText(body, list);
}

/**
 * Analyze a text message: classify the sender, detect lure templates and
 * callback numbers, and run up to `maxUrls` (default 5) links through
 * `analyzeUrl`. Never throws for hostile input; the agent decides the verdict.
 */
export async function analyzeSms(input: SmsInput, opts: AnalyzeSmsOptions = {}): Promise<SmsAnalysis> {
  const started = Date.now();
  const deps = resolveDeps(opts.deps);
  const analyzedAt = deps.mock ? MOCK_ANALYZED_AT : deps.now().toISOString();
  const maxUrls = Math.max(0, Math.min(HARD_MAX_URLS, Math.floor(opts.maxUrls ?? DEFAULT_SMS_MAX_URLS)));
  const userCountry = /^[a-z]{2}$/i.test(input.user_country ?? "") ? input.user_country!.toUpperCase() : "US";
  const errors: string[] = [];

  const body = stripInvisible(stripChrome(input.body ?? ""));
  const { sender, group } = classifySmsSender(input.sender, userCountry);
  const heuristics = new Set<string>();
  const signals = new Set<string>();
  if (group) heuristics.add("group_message");
  if (sender.kind === "email_to_sms") heuristics.add("imessage_from_email");

  // Lure keywords.
  const normalized = normalizeForMatch(body);
  for (const code of smsLureSignals(normalized)) {
    if (code === "reply_stop_bait" && sender.kind === "short_code") continue;
    signals.add(code);
  }
  if (looksLikeInjection(normalized)) signals.add("injection_attempt_in_content");
  if (nonLatinLetterRatio(body) > 0.3) heuristics.add("non_english_body");

  // Brand claim vs sender.
  const brand = smsBrand(body, deps.brands);
  if (brand) {
    sender.claims_brand = brand.name;
    if (sender.kind === "ten_digit" || sender.kind === "email_to_sms") heuristics.add("brand_claim_from_personal_number");
    if (sender.kind === "international") heuristics.add("brand_claim_from_international_number");
  }

  // Links.
  const found = extractTextUrls(body, { lenient: true, max: 50 });
  const seen = new Set<string>();
  const urls: SmsAnalysis["urls"] = [];
  let analyzed = 0;
  let notListed = 0;
  const pending: Promise<void>[] = [];
  for (const f of found) {
    let norm;
    try {
      norm = normalizeUrl(f.url);
    } catch {
      continue;
    }
    if (seen.has(norm.href)) continue;
    seen.add(norm.href);
    if (urls.length >= MAX_LISTED_URLS) {
      notListed++;
      continue;
    }
    const entry: SmsAnalysis["urls"][number] = { url: norm.href };
    urls.push(entry);
    if (norm.scheme !== "http" && norm.scheme !== "https") {
      entry.skipped = "unsupported_scheme";
      continue;
    }
    if (norm.heuristics.includes("url_shortener")) heuristics.add("url_shortener");
    if (norm.is_ip) heuristics.add("bare_ip_url");
    if (norm.heuristics.includes("suspicious_tld")) heuristics.add("unusual_tld");
    if (brand && norm.registrable && !brandOwnsDomain(brand, norm.host)) heuristics.add("link_domain_not_brand");
    if (analyzed >= maxUrls) {
      entry.skipped = "limit";
      continue;
    }
    analyzed++;
    pending.push(
      analyzeUrl(norm.href, { deps, ...(opts.signal ? { signal: opts.signal } : {}) }).then((a) => {
        entry.analysis = a;
      }),
    );
  }
  await Promise.all(pending);
  if (notListed) errors.push(`urls_truncated: ${notListed} more link(s) not listed`);
  for (const u of urls) {
    const a = u.analysis;
    if (!a) continue;
    if (a.heuristics.includes("young_domain")) heuristics.add("first_seen_domain_lt_30d");
    if (a.heuristics.some((x) => x === "safe_browsing_match" || x === "virustotal_malicious" || x === "urlscan_malicious")) heuristics.add("url_reputation_flagged");
    if (a.heuristics.includes("brand_lookalike")) heuristics.add("url_brand_lookalike");
    if (brand && a.final_domain && !a.final_domain.is_ip && !brandOwnsDomain(brand, a.final_domain.host)) heuristics.add("link_domain_not_brand");
  }

  // Callback numbers (URLs removed first).
  const withoutUrls = found.reduce((t, f) => t.split(f.raw).join(" "), body).replace(/\S+@\S+/g, " ");
  const exclude = [sender.e164, sender.raw].filter((x): x is string => !!x);
  const phone_numbers = extractPhoneNumbers(withoutUrls, { userCountry, exclude, max: 10 });
  if (phone_numbers.length) signals.add("callback_number_present");
  if (urls.length && withoutUrls.replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter((w) => w.length > 1).length < 4) heuristics.add("link_only_message");

  for (const s of signals) heuristics.add(s);
  const result: SmsAnalysis = {
    sender,
    urls,
    phone_numbers,
    signals: orderCodes([...signals].filter((c) => SIGNAL_CODES.has(c)), SMS_HEURISTIC_CODES),
    heuristics: orderCodes(heuristics, SMS_HEURISTIC_CODES),
    body_excerpt: clamp(body.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n"), EXCERPT_CHARS),
    errors,
    analyzed_at: analyzedAt,
  };
  if (deps.mock) result.mock = true;

  logger.info(`sms analyzed: analyzed=${analyzed} phones=${phone_numbers.length}`, "tools.sms", {
    toolName: "analyze_sms",
    durationMs: Date.now() - started,
    labels: result.heuristics,
    kind: sender.kind,
    urlCount: urls.length,
  });
  return boundStrings(result, 2048);
}
