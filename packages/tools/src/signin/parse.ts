import { stripInvisible } from "../text.js";
import { MAX_DEVICE_CHARS, MAX_LOCATION_CHARS, maskAccount, redactExcerpt, safeValue } from "./sanitize.js";
import { SIGNIN_TEMPLATES, type SigninTemplate } from "./templates.js";
import type { SignInAlert } from "./types.js";

const MAX_SUBJECT_CHARS = 500;
const MAX_BODY_CHARS = 20_000;
const MAX_SECTION_CHARS = 4000;
const MAX_IPS = 3;

/** The end of the event section: the alert's "if this wasn't you" boilerplate. */
const SECTION_END = /\bif (this was you|this wasn'?t you|you don'?t recognize|you did(n'?t| not)|that was you|that wasn'?t you|you (did not|didn'?t) (sign|log))\b/i;

/** Unicode-normalize, drop invisible characters, collapse spaces within lines (newlines kept for labelled fields). */
function normalizeKeepLines(s: string): string {
  return stripInvisible(s.normalize("NFKC"))
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\u00A0]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function snippet(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 20);
  return redactExcerpt(text.slice(start, Math.min(text.length, index + length + 40)));
}

function firstGroup(text: string, patterns: readonly RegExp[]): string | undefined {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m?.[1]) return m[1];
  }
  return undefined;
}

function label(section: string, names: string): string | undefined {
  return new RegExp(`^ ?(?:${names}) ?[:\\-] ?(.{1,120}?) ?$`, "im").exec(section)?.[1];
}

function deviceLabel(section: string, tpl: SigninTemplate): string | undefined {
  const heading = tpl.device ? firstGroup(section, tpl.device) : undefined;
  if (heading) return safeValue(heading, MAX_DEVICE_CHARS);
  const base = label(section, "device|device name|platform|operating system|os");
  const app = label(section, "browser|app|application");
  return safeValue([base, app].filter(Boolean).join(", "), MAX_DEVICE_CHARS);
}

function validIpv4(s: string): boolean {
  const parts = s.split(".");
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255 && (p === "0" || !p.startsWith("0")));
}

/** IPv4 anywhere in the event section; IPv6 only on a line labelled as an IP address (times also look like IPv6). */
function ipAddresses(section: string): string[] {
  const out = new Set<string>();
  for (const m of section.matchAll(/(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])/g)) if (validIpv4(m[1]!)) out.add(m[1]!);
  for (const m of section.matchAll(/^ ?ip(?: address)? ?[:-] ?([0-9a-f:]{3,39})\b/gim)) {
    if (/^[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}$/i.test(m[1]!) && m[1]!.includes("::")) out.add(m[1]!.toLowerCase());
  }
  return [...out].slice(0, MAX_IPS);
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function offsetMinutes(tz: string): number | undefined {
  if (/^(z|utc|gmt)$/i.test(tz)) return 0;
  const m = /^(?:utc|gmt)?([+-])(\d{2}):?(\d{2})$/i.exec(tz);
  if (!m) return undefined;
  const mins = Number(m[2]) * 60 + Number(m[3]);
  if (Number(m[2]) > 14 || Number(m[3]) > 59) return undefined;
  return m[1] === "-" ? -mins : mins;
}

function toIso(y: number, mo: number, d: number, h: number, mi: number, s: number, offset: number): string | undefined {
  if (mo < 0 || mo > 11 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return undefined;
  const ms = Date.UTC(y, mo, d, h, mi, s) - offset * 60_000;
  const date = new Date(ms);
  // Reject overflowed days such as February 31.
  if (Number.isNaN(ms) || new Date(Date.UTC(y, mo, d)).getUTCDate() !== d) return undefined;
  return date.toISOString();
}

/** UTC ISO time, only for a timestamp that states UTC/GMT/Z or a numeric offset. Anything else is undefined. */
export function parseEventTime(text: string): string | undefined {
  const tz = "(Z|UTC|GMT|(?:UTC|GMT)?[+-]\\d{2}:?\\d{2})";
  const iso = new RegExp(`(\\d{4})-(\\d{2})-(\\d{2})[T ](\\d{2}):(\\d{2})(?::(\\d{2}))?(?:\\.\\d+)? ?${tz}(?![A-Za-z])`, "i").exec(text);
  if (iso) {
    const off = offsetMinutes(iso[7]!);
    if (off !== undefined) return toIso(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), Number(iso[4]), Number(iso[5]), Number(iso[6] ?? 0), off);
  }
  const long = new RegExp(`\\b(${MONTHS.map((m) => m.slice(0, 3)).join("|")})[a-z]*\\.? (\\d{1,2}),? (\\d{4}),? (?:at )?(\\d{1,2}):(\\d{2})(?::(\\d{2}))? ?(AM|PM)? ?\\(?${tz}(?![A-Za-z])`, "i").exec(text);
  if (long) {
    const off = offsetMinutes(long[8]!);
    let hour = Number(long[4]);
    const ampm = long[7]?.toUpperCase();
    if (ampm) {
      if (hour < 1 || hour > 12) return undefined;
      hour = (hour % 12) + (ampm === "PM" ? 12 : 0);
    }
    const mo = MONTHS.findIndex((m) => m.startsWith(long[1]!.toLowerCase()));
    if (off !== undefined) return toIso(Number(long[3]), mo, Number(long[2]), hour, Number(long[5]), Number(long[6] ?? 0), off);
  }
  return undefined;
}

function accountHint(text: string): string | undefined {
  const found = new Set<string>();
  for (const m of text.matchAll(/(?<![\w.+-])[a-z0-9][a-z0-9._+-]{0,63}@[a-z0-9][a-z0-9.-]{0,252}\.[a-z]{2,24}(?![\w-])/gi)) found.add(m[0].toLowerCase());
  if (found.size !== 1) return undefined; // none, or ambiguous: omit
  return maskAccount([...found][0]!);
}

export type SigninParseInput = { subject?: string; body: string; senderDomain?: string; analyzedAt: string };

/**
 * Match one deterministic template against an already-parsed message and extract the alert facts.
 * Returns null for unknown, conflicting (two providers), ambiguous (two templates) or non-English
 * messages. Pure: no network, no model, no logging of message content.
 */
export function parseSigninAlert(input: SigninParseInput): SignInAlert | null {
  const subject = normalizeKeepLines((input.subject ?? "").slice(0, MAX_SUBJECT_CHARS)).replace(/\n/g, " ");
  const body = normalizeKeepLines(input.body.slice(0, MAX_BODY_CHARS));
  if (!body && !subject) return null;
  const all = `${subject}\n${body}`;

  const matches: { tpl: SigninTemplate; event: RegExpExecArray }[] = [];
  for (const tpl of SIGNIN_TEMPLATES) {
    if (!tpl.providerMarkers.some((re) => re.test(all))) continue;
    for (const re of tpl.eventMarkers) {
      const m = re.exec(all);
      if (m) {
        matches.push({ tpl, event: m });
        break;
      }
    }
  }
  if (matches.length !== 1) return null; // none, competing events, or conflicting providers
  const { tpl, event } = matches[0]!;

  // The event section starts at the event marker and ends at the "if this wasn't you" boilerplate.
  const tail = all.slice(Math.max(0, event.index - 200), event.index + MAX_SECTION_CHARS);
  const end = SECTION_END.exec(tail);
  const section = end ? tail.slice(0, end.index) : tail;

  const evidence: SignInAlert["evidence"] = [];
  const inSubject = subject && tpl.eventMarkers.some((re) => re.test(subject));
  const sub = subject ? tpl.providerMarkers.map((re) => re.exec(subject)).find(Boolean) ?? null : null;
  if (inSubject || sub) evidence.push({ field: "subject", excerpt: redactExcerpt(subject) });
  if (input.senderDomain) evidence.push({ field: "sender", excerpt: redactExcerpt(input.senderDomain) });
  if (event.index >= subject.length) evidence.push({ field: "body", excerpt: snippet(all, event.index, event[0].length) });
  else {
    const first = tpl.providerMarkers.map((re) => re.exec(body)).find(Boolean);
    if (first) evidence.push({ field: "body", excerpt: snippet(body, first.index, first[0].length) });
  }

  const alert: SignInAlert = {
    template_id: tpl.id,
    provider: tpl.provider,
    event: tpl.event,
    ip_addresses: ipAddresses(section),
    evidence: evidence.slice(0, 3),
    warnings: tpl.verified ? [] : ["template_unverified"],
    analyzed_at: input.analyzedAt,
  };
  const device = deviceLabel(section, tpl);
  if (device) alert.device = device;
  const location = safeValue(tpl.location ? firstGroup(section, tpl.location) : label(section, "location|near|country/region|approximate location|region"), MAX_LOCATION_CHARS);
  if (location) alert.location = location;
  const when = label(section, "date and time|date|time|when");
  const time = parseEventTime(when ?? "") ?? parseEventTime(section);
  if (time) alert.event_time = time;
  const hint = accountHint(all);
  if (hint) alert.account_hint = hint;
  return alert;
}
