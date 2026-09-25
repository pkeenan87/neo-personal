import { parse as parseDomain } from "tldts";

/** Undo common defanging/obfuscation: hxxp, [.], (.), {.}, [dot], [:]. */
export function refang(text: string): string {
  return text
    .replace(/\bhxxp(s?)(?=:|\[:\])/gi, "http$1")
    .replace(/\[\s*\.\s*\]|\(\s*\.\s*\)|\{\s*\.\s*\}|\[\s*dot\s*\]|\(\s*dot\s*\)/gi, ".")
    .replace(/\[\s*:\s*\]/g, ":")
    .replace(/\[\s*\/\s*\]/g, "/");
}

const SCHEME_URL = /\b(?:https?|ftp):\/\/[^\s<>"'`\u0000-\u001f\u007f]+/gi; // eslint-disable-line no-control-regex
const WWW_URL = /(?<![\w./@-])www\.[^\s<>"'`\u0000-\u001f\u007f]+/gi; // eslint-disable-line no-control-regex
const BARE_URL = /(?<![\w.@/-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,23}(?::\d{2,5})?(?:[/?#][^\s<>"'`]*)?/gi;

const PAIRS: Record<string, string> = { ")": "(", "]": "[", "}": "{", ">": "<" };

/** Remove trailing sentence punctuation and unbalanced closing brackets/quotes. */
export function trimUrlPunctuation(url: string): string {
  let u = url;
  for (;;) {
    const last = u.at(-1);
    if (!last) return u;
    if (".,;:!?'\"*\u2019\u201D\u2026".includes(last)) {
      u = u.slice(0, -1);
      continue;
    }
    const open = PAIRS[last];
    if (open) {
      const opens = u.split(open).length - 1;
      const closes = u.split(last).length - 1;
      if (closes > opens) {
        u = u.slice(0, -1);
        continue;
      }
    }
    return u;
  }
}

function knownDomain(hostish: string): boolean {
  const host = hostish.split(/[/?#:]/)[0] ?? "";
  const p = parseDomain(host, { allowPrivateDomains: false });
  return !!p.domain && p.isIcann === true;
}

export type FoundUrl = { raw: string; url: string };

/**
 * Find URLs in plain text. Strict mode (email bodies): `scheme://` and `www.`
 * links. Lenient mode (SMS): also defanged links (hxxp, [.]) and bare domains
 * on known public suffixes ("usps-redelivery.com/track"), which phones
 * autolink. Returns them in document order, trimmed of trailing punctuation.
 */
export function extractTextUrls(text: string, opts: { lenient?: boolean; max?: number } = {}): FoundUrl[] {
  const max = opts.max ?? 200;
  let work = opts.lenient ? refang(text) : text;
  const found: { index: number; raw: string; url: string }[] = [];
  const take = (re: RegExp, toUrl: (s: string) => string, validate?: (s: string) => boolean) => {
    for (const m of work.matchAll(re)) {
      const raw = trimUrlPunctuation(m[0]);
      const next = work[m.index + m[0].length];
      if (raw.length < 4 || next === "@") continue;
      if (validate && !validate(raw)) continue;
      found.push({ index: m.index, raw, url: toUrl(raw) });
    }
    // Blank out what was taken so later, looser patterns do not match inside it.
    work = work.replace(re, (s) => " ".repeat(s.length));
  };
  take(SCHEME_URL, (s) => s);
  take(WWW_URL, (s) => `https://${s}`, (s) => knownDomain(s.slice(4)) || opts.lenient !== true);
  if (opts.lenient) take(BARE_URL, (s) => `https://${s}`, knownDomain);
  return found
    .sort((a, b) => a.index - b.index)
    .slice(0, max)
    .map(({ raw, url }) => ({ raw, url }));
}
