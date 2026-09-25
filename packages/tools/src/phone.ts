import callingCodes from "./data/country-calling-codes.json" with { type: "json" };
import nanp from "./data/nanp-area-codes.json" with { type: "json" };

/**
 * Minimal phone-number handling without libphonenumber: E.164 country codes
 * from a bundled table plus NANP (+1) rules. Good enough to classify SMS
 * senders and to report callback numbers as IOCs; not a validator.
 */

const CODES = callingCodes.codes as Record<string, string>;
const TOLL_FREE = new Set(nanp.toll_free);
const CANADA = new Set(nanp.canada);
const NANP_OTHER = nanp.other_countries as Record<string, string>;
const NANP_COUNTRIES = new Set(["US", "CA"]);

export type ParsedPhone = { e164: string; country?: string; toll_free: boolean; nanp: boolean };

/** Country for a NANP 10-digit national number (area code + 7). */
function nanpCountry(national: string): string {
  const area = national.slice(0, 3);
  if (CANADA.has(area)) return "CA";
  return NANP_OTHER[area] ?? "US";
}

function fromE164Digits(digits: string): ParsedPhone | undefined {
  if (digits.length < 8 || digits.length > 15) return undefined;
  if (digits.startsWith("1")) {
    const national = digits.slice(1);
    if (national.length !== 10 || !/^[2-9]\d{2}[2-9]\d{6}$/.test(national)) return undefined;
    return { e164: `+${digits}`, country: nanpCountry(national), toll_free: TOLL_FREE.has(national.slice(0, 3)), nanp: true };
  }
  for (const len of [3, 2, 1]) {
    const cc = digits.slice(0, len);
    const country = CODES[cc];
    if (country && country !== "US") return { e164: `+${digits}`, country, toll_free: false, nanp: false };
  }
  return undefined;
}

/**
 * Parse a phone number as written ("+44 7700 900123", "(202) 555-0147",
 * "011 44 ..."). National numbers without `+` are read in `userCountry`
 * (NANP rules for US/CA; other countries only get an E.164 when a leading
 * trunk 0 can be replaced by the country code).
 */
export function parsePhone(raw: string, userCountry = "US"): ParsedPhone | undefined {
  const trimmed = raw.trim();
  const plus = /^\+/.test(trimmed) || /^00\d/.test(trimmed.replace(/[\s().-]/g, ""));
  let digits = trimmed.replace(/\D/g, "");
  if (!digits) return undefined;
  if (plus) return fromE164Digits(digits.replace(/^00/, ""));
  const uc = userCountry.toUpperCase();
  if (NANP_COUNTRIES.has(uc)) {
    if (digits.startsWith("011")) return fromE164Digits(digits.slice(3));
    if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
    if (digits.length === 10) return fromE164Digits(`1${digits}`);
    return undefined;
  }
  const cc = Object.keys(CODES).find((k) => CODES[k] === uc);
  if (cc && digits.startsWith("0") && digits.length >= 9 && digits.length <= 12) return fromE164Digits(`${cc}${digits.slice(1)}`);
  return undefined;
}

/** Callback-number candidates: NANP-style groups and `+`-prefixed international numbers. */
const PHONE_RE = /(?<![\w+])(?:\+\d{1,3}[\s.-]?(?:\(\d{1,4}\)[\s.-]?)?\d{1,4}(?:[\s.-]?\d{2,4}){1,4}|(?:1[\s.-]?)?\(?[2-9]\d{2}\)?[\s.-]?\d{3}[\s.-]?\d{4})(?![\w])/g;

/**
 * Extract phone numbers from free text (URLs and email addresses should be
 * removed by the caller first). Returns E.164 where parseable, otherwise the
 * digits as written; de-duplicated, excluding `exclude` (e.g. the sender).
 */
export function extractPhoneNumbers(text: string, opts: { userCountry?: string; exclude?: string[]; max?: number } = {}): string[] {
  const exclude = new Set((opts.exclude ?? []).map((e) => e.replace(/\D/g, "")));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(PHONE_RE)) {
    const raw = m[0];
    const digits = raw.replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 15) continue;
    const parsed = parsePhone(raw, opts.userCountry);
    const value = parsed?.e164 ?? (raw.trim().startsWith("+") ? `+${digits}` : digits);
    const key = value.replace(/\D/g, "");
    if (seen.has(key) || [...exclude].some((e) => e.length >= 10 && (key === e || key.endsWith(e) || e.endsWith(key)))) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= (opts.max ?? 10)) break;
  }
  return out;
}

export function isNanpCountry(country: string | undefined): boolean {
  return !!country && NANP_COUNTRIES.has(country.toUpperCase());
}
