import { domainToUnicode } from "node:url";
import { isIP } from "node:net";
import { parse as parseDomain } from "tldts";
import { blockedAddressReason } from "./ssrf.js";

/** Stable heuristic codes emitted in `UrlAnalysis.heuristics`. */
export const HEURISTIC_CODES = {
  // normalization
  unparseable_url: "URL could not be parsed",
  non_http_scheme: "Scheme is not http or https (javascript:, data:, file:, ...)",
  plain_http: "Uses unencrypted http",
  ip_literal_host: "Host is a raw IP address instead of a domain name",
  private_ip_host: "Host is a private, loopback, or otherwise non-public IP",
  userinfo_in_url: "URL contains user@ credentials before the host (the real host is after @)",
  excessive_subdomains: "Three or more subdomain levels",
  suspicious_tld: "TLD frequently abused for phishing",
  url_shortener: "Known URL shortener hides the destination",
  credential_keywords_in_path: "Path or query contains login/verify/secure-style keywords",
  credential_keywords_in_host: "Host name contains login/verify/secure-style keywords",
  hex_blob_in_url: "Long hexadecimal blob in path/query (tracking id or encoded payload)",
  base64_blob_in_url: "Long base64 blob in path/query (often encodes the victim's email)",
  email_in_url: "An email address appears in the URL",
  nonstandard_port: "Explicit non-default port",
  punycode_host: "Internationalized (punycode) host name",
  mixed_script_host: "Host mixes Latin with Cyrillic/Greek or other scripts",
  long_url: "URL longer than 200 characters",
  many_hyphens: "Registrable domain contains 3+ hyphens",
  no_registrable_domain: "Host has no recognizable registrable domain",
  // network checks
  ssrf_refused: "Destination refused by SSRF guard (private/internal address)",
  too_many_redirects: "Redirect chain exceeded the hop limit",
  cross_domain_redirect: "Final destination is on a different registrable domain",
  redirect_to_http: "Redirect chain downgrades from https to http",
  password_field: "Final page contains a password input",
  young_domain: "Domain registered less than 30 days ago",
  very_young_domain: "Domain registered less than 7 days ago",
  new_certificate: "TLS certificate issued less than 30 days ago",
  invalid_certificate: "TLS certificate failed validation",
  self_signed_certificate: "TLS certificate is self-signed",
  expired_certificate: "TLS certificate is expired",
  brand_lookalike: "Host imitates a well-known brand",
  safe_browsing_match: "Google Safe Browsing lists this URL",
  virustotal_malicious: "One or more VirusTotal engines flag this URL as malicious",
  virustotal_suspicious: "One or more VirusTotal engines flag this URL as suspicious",
  urlscan_malicious: "urlscan.io verdict is malicious",
} as const;
export type HeuristicCode = keyof typeof HEURISTIC_CODES;

const HEURISTIC_ORDER = Object.keys(HEURISTIC_CODES);
/** Deduplicate and order codes by their position in HEURISTIC_CODES (stable output). */
export function sortHeuristics(codes: Iterable<string>): string[] {
  const idx = (c: string) => {
    const i = HEURISTIC_ORDER.indexOf(c);
    return i === -1 ? HEURISTIC_ORDER.length : i;
  };
  return [...new Set(codes)].sort((a, b) => idx(a) - idx(b) || a.localeCompare(b));
}

export const SUSPICIOUS_TLDS = new Set([
  "zip", "mov", "xyz", "top", "tk", "ml", "ga", "cf", "gq", "pw", "click", "link", "work", "rest", "fit", "loan",
  "men", "gdn", "cam", "buzz", "monster", "cyou", "icu", "sbs", "bond", "cfd", "lol", "quest", "support", "country",
  "kim", "science", "party", "review", "date", "racing", "win", "bid", "stream", "download", "accountant", "cricket",
  "faith", "trade", "webcam", "online", "site", "website", "space", "fun", "live", "shop", "store", "vip", "rest",
  "surf", "uno", "best", "beauty", "hair", "skin", "makeup", "autos", "boats", "homes", "motorcycles", "yachts",
]);

export const URL_SHORTENERS = new Set([
  "bit.ly", "bitly.com", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "buff.ly", "rebrand.ly", "cutt.ly",
  "shorturl.at", "tiny.cc", "rb.gy", "bl.ink", "t.ly", "s.id", "v.gd", "lnkd.in", "qrco.de", "trib.al", "shorte.st",
  "adf.ly", "bit.do", "x.co", "soo.gd", "clck.ru", "u.to", "tr.im", "cli.re", "short.io", "surl.li", "tiny.one",
  "t.me", "linktr.ee", "urlz.fr", "shrtco.de", "2.gp", "1url.com", "n9.cl", "han.gl", "me-qr.com", "urlr.me",
]);

const CREDENTIAL_WORDS = [
  "login", "log-in", "logon", "signin", "sign-in", "verify", "verification", "secure", "security", "account",
  "update", "confirm", "banking", "password", "passwd", "credential", "wallet", "unlock", "suspend", "suspended",
  "validate", "authenticate", "webscr", "recover", "recovery", "billing", "invoice", "refund", "reactivate", "2fa", "mfa", "sso",
];
const CREDENTIAL_RE = new RegExp(`(^|[^a-z])(${CREDENTIAL_WORDS.map((w) => w.replace("-", "\\-")).join("|")})`, "i");

export type NormalizedUrl = {
  input: string;
  href: string;
  display_url: string;
  scheme: string;
  host: string;
  host_unicode: string;
  registrable: string;
  subdomain: string;
  public_suffix: string;
  port: string;
  is_ip: boolean;
  is_private_ip: boolean;
  is_shortener: boolean;
  heuristics: HeuristicCode[];
};

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const HOST_PORT = /^[^/:?#@]+:\d+(?:[/?#]|$)/;

/** Parse a user-supplied URL; bare domains ("paypal.com/login") are treated as https. */
export function toUrl(input: string): URL {
  // eslint-disable-next-line no-control-regex -- strip control chars pasted with URLs
  const trimmed = input.trim().replace(/[\u0000-\u001f\u007f\s]+/g, "");
  const withScheme = HAS_SCHEME.test(trimmed) && !HOST_PORT.test(trimmed) ? trimmed : `https://${trimmed.replace(/^\/+/, "")}`;
  return new URL(withScheme);
}

function hasMixedScripts(label: string): boolean {
  const latin = /[a-z]/i.test(label);
  const other = /[\u{370}-\u{3ff}\u{400}-\u{4ff}\u{500}-\u{52f}\u{530}-\u{58f}\u{13a0}-\u{13ff}]/u.test(label);
  return latin && other;
}

export function registrableOf(host: string): { registrable: string; subdomain: string; public_suffix: string; is_ip: boolean } {
  const bare = host.replace(/^\[|\]$/g, "");
  if (isIP(bare)) return { registrable: bare, subdomain: "", public_suffix: "", is_ip: true };
  const p = parseDomain(bare, { allowPrivateDomains: false });
  return { registrable: p.domain ?? "", subdomain: p.subdomain ?? "", public_suffix: p.publicSuffix ?? "", is_ip: false };
}

export function normalizeUrl(input: string): NormalizedUrl {
  const u = toUrl(input);
  const heuristics = new Set<HeuristicCode>();
  const scheme = u.protocol.replace(/:$/, "");

  if (u.protocol !== "http:" && u.protocol !== "https:") heuristics.add("non_http_scheme");
  if (u.protocol === "http:") heuristics.add("plain_http");
  if (u.username || u.password || /^[a-z]+:\/\/[^/?#]*@/i.test(input.trim())) heuristics.add("userinfo_in_url");

  u.hash = "";
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  const bare = host.replace(/^\[|\]$/g, "");
  const host_unicode = isIP(bare) ? host : domainToUnicode(host) || host;
  const { registrable, subdomain, public_suffix, is_ip } = registrableOf(host);

  let is_private_ip = false;
  if (is_ip) {
    heuristics.add("ip_literal_host");
    if (blockedAddressReason(bare)) {
      heuristics.add("private_ip_host");
      is_private_ip = true;
    }
  } else if (host) {
    if (!registrable) heuristics.add("no_registrable_domain");
    if (host.split(".").some((l) => l.startsWith("xn--"))) heuristics.add("punycode_host");
    if (host_unicode.split(".").some(hasMixedScripts)) heuristics.add("mixed_script_host");
    const subLabels = subdomain.split(".").filter((l) => l && l !== "www");
    if (subLabels.length >= 3) heuristics.add("excessive_subdomains");
    const tld = public_suffix.split(".").pop() ?? "";
    if (SUSPICIOUS_TLDS.has(tld)) heuristics.add("suspicious_tld");
    const labelUnicode = domainToUnicode(registrable) || registrable;
    if ((labelUnicode.match(/-/g) ?? []).length >= 3) heuristics.add("many_hyphens");
    if (CREDENTIAL_RE.test(host.replace(registrable ? `.${public_suffix}` : "", ""))) heuristics.add("credential_keywords_in_host");
  }

  const is_shortener = URL_SHORTENERS.has(host) || URL_SHORTENERS.has(registrable);
  if (is_shortener) heuristics.add("url_shortener");
  if (u.port) heuristics.add("nonstandard_port");

  let pathAndQuery = u.pathname + u.search;
  try {
    pathAndQuery = decodeURIComponent(pathAndQuery);
  } catch {
    /* keep raw */
  }
  if (CREDENTIAL_RE.test(pathAndQuery)) heuristics.add("credential_keywords_in_path");
  if (/[0-9a-f]{32,}/i.test(pathAndQuery)) heuristics.add("hex_blob_in_url");
  const b64 = pathAndQuery.match(/[A-Za-z0-9+/_-]{40,}={0,2}/g) ?? [];
  if (b64.some((s) => /[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9]/.test(s) && !/^[0-9a-f]+$/i.test(s))) heuristics.add("base64_blob_in_url");
  if (/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(pathAndQuery) || b64Emails(pathAndQuery.match(/[A-Za-z0-9+/_-]{16,}={0,2}/g) ?? [])) {
    heuristics.add("email_in_url");
  }

  const href = u.href;
  if (href.length > 200) heuristics.add("long_url");

  let display_url = href;
  if (host_unicode !== host) display_url = href.replace(`//${u.host}`, `//${host_unicode}${u.port ? `:${u.port}` : ""}`);

  return {
    input,
    href,
    display_url,
    scheme,
    host,
    host_unicode,
    registrable,
    subdomain,
    public_suffix,
    port: u.port,
    is_ip,
    is_private_ip,
    is_shortener,
    heuristics: [...heuristics],
  };
}

function b64Emails(blobs: string[]): boolean {
  return blobs.some((s) => {
    try {
      return /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("latin1"));
    } catch {
      return false;
    }
  });
}
