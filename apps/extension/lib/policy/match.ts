/**
 * Child-mode matching (`_specs/v2-m2-child.md` sections 3 and 5): which hostnames the policy blocks.
 * Pure apart from WebCrypto; the category data arrives through a `PrefixLookup` so tests (and the
 * background) choose where it comes from.
 *
 * Order: `web.allow` and a running `web.allowOnce` override everything; then the parent's `web.block`
 * list; then the blocked categories (a 32-bit hash-prefix lookup of the host and each parent domain
 * up to the registrable domain). A prefix lookup can false-positive (about n / 2^32 per lookup); the
 * allow list is the answer to that.
 */
import { registrableDomain } from "@neo/tools/browser";
import type { PolicyBundle, WebCategory } from "@neo/verdict";
import { TOP_DOMAINS } from "./topDomains.js";

/** True when `prefix` is among the sorted values of `sorted`. */
export function binarySearch(sorted: Uint32Array, value: number): boolean {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const v = sorted[mid]!;
    if (v === value) return true;
    if (v < value) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

/** First 4 bytes of SHA-256(domain), big-endian: the same value `scripts/category-lists/normalize.mjs` writes. */
export async function domainPrefix(domain: string): Promise<number> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(domain));
  return new DataView(digest).getUint32(0, false);
}

/** Decodes a `.bin` file (uint32, little-endian, ascending) into an array that `binarySearch` can use on any platform. */
export function decodeBin(bytes: ArrayBuffer): Uint32Array | null {
  if (bytes.byteLength % 4 !== 0) return null;
  const view = new DataView(bytes);
  const out = new Uint32Array(bytes.byteLength / 4);
  for (let i = 0; i < out.length; i++) out[i] = view.getUint32(i * 4, true);
  return out;
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Lowercase host without a trailing dot or IPv6 brackets. */
export function cleanHost(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
}

/** The host and each parent domain down to (and including) its registrable domain. An IP or unrecognized host is just itself. */
export function hostCandidates(hostname: string): string[] {
  const host = cleanHost(hostname);
  if (!host) return [];
  if (host.includes(":") || IPV4.test(host)) return [host];
  const info = registrableDomain(host);
  if (!info || info.isIp || !(host === info.registrable || host.endsWith(`.${info.registrable}`))) return [host];
  const out: string[] = [];
  let current = host;
  for (;;) {
    out.push(current);
    if (current === info.registrable) break;
    current = current.slice(current.indexOf(".") + 1);
  }
  return out;
}

/** Every suffix of the host with at least two labels (an allow entry may name a parent above the registrable domain only in theory; this is the safe superset). */
function allSuffixes(host: string): string[] {
  const labels = cleanHost(host).split(".");
  const out: string[] = [];
  for (let i = 0; i + 1 < labels.length; i++) out.push(labels.slice(i).join("."));
  return out.length ? out : [cleanHost(host)];
}

/** True when the host is one of `entries` or a subdomain of one. */
export function matchesDomainList(hostname: string, entries: readonly string[]): boolean {
  if (entries.length === 0) return false;
  const set = new Set(entries.map((e) => cleanHost(e)));
  return allSuffixes(hostname).some((s) => set.has(s));
}

/** `web.allow` entries plus the `web.allowOnce` entries whose `until` is still in the future. */
export function activeAllowList(web: PolicyBundle["web"], now: number): string[] {
  const once = (web.allowOnce ?? []).filter((g) => Date.parse(g.until) > now).map((g) => g.domain);
  return [...web.allow, ...once];
}

export interface BlockDecision {
  blocked: boolean;
  /** The blocked category; null for a hit on the parent's own block list. */
  category?: WebCategory | null;
  /** The list entry or host that matched (what the block page shows and what "Ask to unblock" names). */
  domain?: string;
  reason?: "block_list" | "category";
}

/** Looks a prefix up in a category's data; false when that category's data is not loaded. */
export type PrefixLookup = (category: WebCategory, prefix: number) => Promise<boolean>;

export async function decideHost(hostname: string, bundle: PolicyBundle, lookup: PrefixLookup, now: number): Promise<BlockDecision> {
  if (bundle.mode !== "child") return { blocked: false };
  const host = cleanHost(hostname);
  if (!host.includes(".")) return { blocked: false };
  if (matchesDomainList(host, activeAllowList(bundle.web, now))) return { blocked: false };
  const blockSet = new Set(bundle.web.block.map((b) => cleanHost(b)));
  const blockedEntry = allSuffixes(host).find((s) => blockSet.has(s));
  if (blockedEntry) return { blocked: true, category: null, domain: blockedEntry, reason: "block_list" };
  if (bundle.web.categories.length === 0) return { blocked: false };
  // The well-known domains that have a DNR rule: matched exactly, so the rules, the content script and the
  // block page always agree (and these block before the category files have downloaded).
  for (const category of bundle.web.categories) {
    const entry = allSuffixes(host).find((s) => TOP_DOMAINS[category].includes(s));
    if (entry) return { blocked: true, category, domain: entry, reason: "category" };
  }
  for (const candidate of hostCandidates(host)) {
    const prefix = await domainPrefix(candidate);
    for (const category of bundle.web.categories) {
      if (await lookup(category, prefix)) return { blocked: true, category, domain: candidate, reason: "category" };
    }
  }
  return { blocked: false };
}
