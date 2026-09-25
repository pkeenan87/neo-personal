import { normalizeUrl, registrableOf } from "../checks/normalize.js";
import { extractTextUrls } from "../textUrls.js";
import { cleanLine, decodeEntities } from "../text.js";
import type { HtmlFacts } from "./html.js";
import type { EmailUrlEntry } from "./types.js";

export const MAX_LISTED_URLS = 50;
export const MANY_URLS_THRESHOLD = 25;

export type UrlCandidate = EmailUrlEntry & { key: string; tier: number };

export type CollectedUrls = {
  candidates: UrlCandidate[];
  mailto_domains: string[];
  tel_numbers: string[];
  unique_http: number;
  mismatches: number;
};

const TRACKING_REGISTRABLES = new Set([
  "sendgrid.net", "list-manage.com", "mailchimp.com", "mailchi.mp", "mandrillapp.com", "hubspotlinks.com", "hs-sites.com",
  "exacttarget.com", "rs6.net", "mcsv.net", "mktoweb.com", "mkt.com", "sparkpostmail.com", "mailgun.org", "mailjet.com",
  "klaviyomail.com", "cmail19.com", "cmail20.com", "createsend1.com", "createsend.com", "constantcontact.com", "customeriomail.com",
]);
const TRACKING_HOST_RE = /^(?:click|clicks|link|links|l|email|e|trk|track|tracking|go|r|em|url\d*|ablink|u\d+|t)\./i;
const UNSUBSCRIBE_RE = /unsubscribe|opt-?out|email-?preferences|manage-?preferences|notification[-_]?settings/i;
const URLISH_TEXT_RE = /^(?:https?:\/\/)?(?:www\.)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:[/:?#]\S*)?$/i;
const EMBEDDED_URL_RE = /https?:\/\/((?:[a-z0-9-]+\.)+[a-z]{2,})/i;

/** Unwrap Microsoft Safe Links, Proofpoint URL Defense, and Google redirect wrappers to the real destination. */
export function unwrapRedirector(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host === "safelinks.protection.outlook.com" || host.endsWith(".safelinks.protection.outlook.com")) return u.searchParams.get("url") ?? url;
    if ((host === "www.google.com" || host === "google.com") && u.pathname === "/url") return u.searchParams.get("q") ?? u.searchParams.get("url") ?? url;
    if (host === "urldefense.proofpoint.com" && u.pathname.startsWith("/v2/")) {
      const enc = u.searchParams.get("u");
      if (enc) return decodeURIComponent(enc.replace(/-([0-9A-F]{2})/gi, "%$1").replace(/_/g, "/"));
    }
    if (host === "urldefense.com" && u.pathname.startsWith("/v3/__")) {
      const m = /^\/v3\/__(.+?)__;/.exec(u.pathname + u.search);
      if (m?.[1]) return m[1];
    }
  } catch {
    /* not a URL */
  }
  return url;
}

/** Registrable domain the visible link text claims, when the text looks like a URL or domain. */
export function claimedTextRegistrable(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const t = text.trim();
  if (!t || t.length > 300) return undefined;
  const host = URLISH_TEXT_RE.exec(t)?.[1] ?? EMBEDDED_URL_RE.exec(t)?.[1];
  if (!host) return undefined;
  const reg = registrableOf(host.toLowerCase()).registrable;
  return reg || undefined;
}

function isTracking(host: string, registrable: string, href: string): boolean {
  return TRACKING_REGISTRABLES.has(registrable) || TRACKING_HOST_RE.test(host) || UNSUBSCRIBE_RE.test(href);
}

/**
 * Gather link candidates from HTML anchors, active resources (form actions,
 * iframes), and plain-text URLs; de-duplicate by normalized URL; route
 * mailto:/tel: to IOCs; mark non-web schemes unsupported; skip cid: and
 * fragments. Candidates carry a priority tier (0 = analyze first).
 */
export function collectEmailUrls(input: { html?: HtmlFacts; text?: string }): CollectedUrls {
  const byKey = new Map<string, UrlCandidate>();
  const mailto = new Set<string>();
  const tel = new Set<string>();
  let order = 0;
  const seenOrder = new Map<string, number>();

  const add = (rawHref: string, displayText: string | undefined, source: "href" | "resource" | "text") => {
    const href = decodeEntities(rawHref).trim().replace(/^["']|["']$/g, "");
    if (!href || href.startsWith("#")) return;
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)?.[1]?.toLowerCase();
    if (scheme === "cid") return;
    if (scheme === "mailto") {
      const addr = decodeURIComponent(href.slice(7).split("?")[0] ?? "").trim();
      const domain = addr.includes("@") ? addr.slice(addr.lastIndexOf("@") + 1).toLowerCase() : "";
      if (domain) mailto.add(domain);
      return;
    }
    if (scheme === "tel" || scheme === "sms") {
      const num = href.slice(scheme.length + 1).replace(/[^\d+]/g, "");
      if (num.length >= 7) tel.add(num);
      return;
    }
    if (!scheme) {
      if (!/^www\./i.test(href)) return; // relative links mean nothing in an email
    } else if (scheme !== "http" && scheme !== "https") {
      const key = `unsupported:${href.slice(0, 200)}`;
      if (!byKey.has(key)) {
        byKey.set(key, { url: cleanLine(href, 300), text_mismatch: false, skipped: "unsupported_scheme", key, tier: 9 });
        seenOrder.set(key, order++);
      }
      return;
    }
    const target = unwrapRedirector(scheme ? href : `https://${href}`);
    let norm;
    try {
      norm = normalizeUrl(target);
    } catch {
      return;
    }
    const claimed = claimedTextRegistrable(displayText);
    const mismatch = !!claimed && !!norm.registrable && claimed !== norm.registrable;
    const text = displayText ? cleanLine(displayText, 200) : undefined;
    const existing = byKey.get(norm.href);
    if (existing) {
      if (mismatch && !existing.text_mismatch) {
        existing.text_mismatch = true;
        if (text) existing.display_text = text;
        existing.tier = 0;
      } else if (!existing.display_text && text) {
        existing.display_text = text;
      }
      if (source === "resource") existing.tier = Math.min(existing.tier, 1);
      return;
    }
    const tier = mismatch ? 0 : source === "resource" ? 1 : isTracking(norm.host, norm.registrable, norm.href) ? 3 : 2;
    const entry: UrlCandidate = { url: norm.href, text_mismatch: mismatch, key: norm.href, tier };
    if (text) entry.display_text = text;
    byKey.set(norm.href, entry);
    seenOrder.set(norm.href, order++);
  };

  for (const a of input.html?.anchors ?? []) add(a.href, a.text, "href");
  for (const r of input.html?.resource_urls ?? []) add(r, undefined, "resource");
  for (const u of extractTextUrls(input.text ?? "")) add(u.url, undefined, "text");

  const candidates = [...byKey.values()].sort((a, b) => a.tier - b.tier || seenOrder.get(a.key)! - seenOrder.get(b.key)!);
  return {
    candidates,
    mailto_domains: [...mailto].slice(0, 20),
    tel_numbers: [...tel].slice(0, 10),
    unique_http: candidates.filter((c) => !c.skipped).length,
    mismatches: candidates.filter((c) => c.text_mismatch).length,
  };
}
