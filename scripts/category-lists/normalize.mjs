/**
 * Pure helpers for the category lists (_specs/v2-m2-child.md section 5): normalize a source line to
 * a hostname, hash a domain to the 32-bit prefix the extension looks up, and encode a sorted set of
 * prefixes. No I/O and no network, so the unit tests run on small fixtures.
 *
 * The prefix is the first 4 bytes of SHA-256(domain) read big-endian; the `.bin` file is those
 * values, unique and sorted ascending, each written little-endian (4 bytes per domain). The
 * extension computes the same prefix with WebCrypto (apps/extension/lib/policy/match.ts) and the
 * two are cross-checked in apps/extension/test/category-lists-build.test.ts.
 */
import { createHash } from "node:crypto";

const LABEL = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * A line from a hosts-style or plain domain list to a lowercase hostname, or null when the line is a
 * comment, blank, an IP, a URL/path, or not a registrable-looking hostname (at least two labels, a
 * letters-only or punycode TLD, labels of letters, digits and hyphens).
 * Strips: comments (whole line `#`/`!` or trailing ` #...`), a leading `0.0.0.0 ` or `127.0.0.1 `,
 * Adblock `||` ... `^`, a `*.` wildcard prefix, a trailing dot.
 */
export function normalizeHostLine(line) {
  let s = String(line).trim();
  if (!s || s.startsWith("#") || s.startsWith("!")) return null;
  const hash = s.indexOf(" #");
  if (hash !== -1) s = s.slice(0, hash).trim();
  // hosts format: "<ip> <host>"
  const parts = s.split(/\s+/);
  if (parts.length === 2 && (IPV4.test(parts[0]) || parts[0] === "::1" || parts[0] === "::")) s = parts[1];
  else if (parts.length !== 1) return null;
  if (s.startsWith("||")) s = s.slice(2);
  if (s.endsWith("^")) s = s.slice(0, -1);
  while (s.startsWith("*.")) s = s.slice(2);
  s = s.replace(/\.$/, "").toLowerCase();
  if (!s || s.length > 253 || IPV4.test(s)) return null;
  const labels = s.split(".");
  if (labels.length < 2) return null;
  if (!labels.every((l) => LABEL.test(l))) return null;
  const tld = labels[labels.length - 1];
  if (!(/^[a-z]{2,63}$/.test(tld) || /^xn--[a-z0-9-]{1,59}$/.test(tld))) return null;
  return s;
}

/** All hostnames in a source text, normalized and deduplicated (insertion order). */
export function parseList(text) {
  const out = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    const host = normalizeHostLine(line);
    if (host) out.add(host);
  }
  return [...out];
}

/** First 4 bytes of SHA-256(domain) as an unsigned big-endian integer. */
export function domainPrefix(domain) {
  return createHash("sha256").update(domain, "utf8").digest().readUInt32BE(0);
}

/** Unique, ascending prefixes for a set of domains. Collisions between different domains collapse to one entry. */
export function prefixesFor(domains) {
  const set = new Set();
  for (const d of domains) set.add(domainPrefix(d));
  return Uint32Array.from(set).sort();
}

/** The `.bin` encoding: each prefix as 4 little-endian bytes. */
export function encodeBin(prefixes) {
  const buf = Buffer.alloc(prefixes.length * 4);
  for (let i = 0; i < prefixes.length; i++) buf.writeUInt32LE(prefixes[i], i * 4);
  return buf;
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
