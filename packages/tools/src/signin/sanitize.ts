import { cleanLine } from "../text.js";

export const MAX_DEVICE_CHARS = 80;
export const MAX_LOCATION_CHARS = 80;
export const MAX_EXCERPT_CHARS = 120;

/**
 * Output value hygiene: control, bidi-override and zero-width characters removed (cleanLine), whitespace
 * collapsed, length bounded. Empty results are undefined. Values that look like addresses or links are
 * dropped: alert facts never carry URLs, codes or full email addresses.
 */
export function safeValue(raw: string | undefined, max: number): string | undefined {
  if (!raw) return undefined;
  const v = cleanLine(raw, max);
  if (!v) return undefined;
  if (/https?:\/\/|www\.|[^\s@]+@[^\s@]+/i.test(v)) return undefined;
  return v;
}

/** `jordan@example.com` -> `j***@e***.com`; undefined when the address does not look simple enough to mask safely. */
export function maskAccount(addr: string): string | undefined {
  const m = /^([a-z0-9][a-z0-9._+-]{0,63})@([a-z0-9][a-z0-9-]{0,62})((?:\.[a-z0-9-]{1,63}){1,4})$/i.exec(addr.trim());
  if (!m) return undefined;
  const tld = m[3]!.slice(m[3]!.lastIndexOf("."));
  return `${m[1]![0]}***@${m[2]![0]}***${tld}`;
}

/** Evidence excerpts quote the message, so addresses, links and long digit runs (codes) are replaced before storing. */
export function redactExcerpt(raw: string): string {
  return cleanLine(raw, 400)
    .replace(/[^\s@<>()]+@[^\s@<>()]+/g, "[address]")
    .replace(/(?:https?:\/\/|www\.)\S+/gi, "[link]")
    .replace(/\b\d{6,}\b/g, "[number]")
    .slice(0, MAX_EXCERPT_CHARS);
}
