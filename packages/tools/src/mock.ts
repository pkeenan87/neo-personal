import { detectLookalike } from "./checks/lookalike.js";
import { sortHeuristics, type NormalizedUrl } from "./checks/normalize.js";
import type { UrlAnalysis, UrlAnalysisDeps } from "./types.js";

/** Fixed timestamp so mock output is byte-for-byte deterministic. */
export const MOCK_ANALYZED_AT = "2026-01-15T12:00:00.000Z";

export const MOCK_URLS = {
  clean: "https://example.com/",
  phish: "https://paypa1-secure-login.com/verify",
  shortener: "http://bit.ly/3xyz",
  ssrf: "https://192.168.1.1/admin",
} as const;

const FIXTURES: Record<string, UrlAnalysis> = {
  [MOCK_URLS.clean]: {
    input: MOCK_URLS.clean,
    normalized_url: "https://example.com/",
    display_url: "https://example.com/",
    final_url: "https://example.com/",
    redirect_chain: ["https://example.com/"],
    page: {
      hops: [{ url: "https://example.com/", status: 200, method: "GET" }],
      final_status: 200,
      content_type: "text/html; charset=UTF-8",
      title: "Example Domain",
      has_password_field: false,
      favicon_url: "https://example.com/favicon.ico",
    },
    domain: {
      host: "example.com",
      host_unicode: "example.com",
      registrable: "example.com",
      is_ip: false,
      age_days: 11109,
      registrar: "RESERVED-Internet Assigned Numbers Authority",
      created: "1995-08-14T04:00:00Z",
      expires: "2026-08-13T04:00:00Z",
      status: ["client delete prohibited", "client transfer prohibited", "client update prohibited"],
    },
    reputation: {
      safe_browsing: { flagged: false, matches: [] },
      virustotal: {
        status: "found",
        malicious: 0,
        suspicious: 0,
        harmless: 68,
        undetected: 26,
        top_engines: [],
        reputation: 12,
        last_analysis_date: "2026-01-14T09:30:00.000Z",
        permalink: "https://www.virustotal.com/gui/url/aHR0cHM6Ly9leGFtcGxlLmNvbS8",
      },
      urlscan: { skipped: "disabled" },
    },
    tls: {
      host: "example.com",
      issuer: "DigiCert Inc",
      subject: "*.example.com",
      valid_from: "2025-01-15T00:00:00.000Z",
      valid_to: "2026-01-15T23:59:59.000Z",
      san_count: 8,
      cert_age_days: 365,
      is_new: false,
      expired: false,
      self_signed: false,
      valid: true,
    },
    lookalike: null,
    heuristics: [],
    errors: [],
    analyzed_at: MOCK_ANALYZED_AT,
  },

  [MOCK_URLS.phish]: {
    input: MOCK_URLS.phish,
    normalized_url: "https://paypa1-secure-login.com/verify",
    display_url: "https://paypa1-secure-login.com/verify",
    final_url: "https://paypa1-secure-login.com/verify/signin",
    redirect_chain: ["https://paypa1-secure-login.com/verify", "https://paypa1-secure-login.com/verify/signin"],
    page: {
      hops: [
        { url: "https://paypa1-secure-login.com/verify", status: 302, method: "HEAD" },
        { url: "https://paypa1-secure-login.com/verify/signin", status: 200, method: "GET" },
      ],
      final_status: 200,
      content_type: "text/html; charset=utf-8",
      title: "Log in to your PayPal account",
      has_password_field: true,
      favicon_url: "https://paypa1-secure-login.com/assets/pp-favicon.ico",
    },
    domain: {
      host: "paypa1-secure-login.com",
      host_unicode: "paypa1-secure-login.com",
      registrable: "paypa1-secure-login.com",
      is_ip: false,
      age_days: 3,
      registrar: "NameSilo, LLC",
      created: "2026-01-12T08:14:22Z",
      expires: "2027-01-12T08:14:22Z",
      status: ["client transfer prohibited"],
    },
    reputation: {
      safe_browsing: {
        flagged: true,
        matches: [{ threat_type: "SOCIAL_ENGINEERING", platform: "ANY_PLATFORM", url: "https://paypa1-secure-login.com/verify" }],
      },
      virustotal: {
        status: "found",
        malicious: 9,
        suspicious: 2,
        harmless: 55,
        undetected: 28,
        top_engines: ["BitDefender (phishing)", "ESET (phishing)", "Fortinet (phishing)", "Kaspersky (phishing)", "Sophos (phishing)"],
        reputation: -35,
        last_analysis_date: "2026-01-15T10:02:00.000Z",
        permalink: "https://www.virustotal.com/gui/url/aHR0cHM6Ly9wYXlwYTEtc2VjdXJlLWxvZ2luLmNvbS92ZXJpZnk",
      },
      urlscan: { skipped: "disabled" },
    },
    tls: {
      host: "paypa1-secure-login.com",
      issuer: "Let's Encrypt",
      subject: "paypa1-secure-login.com",
      valid_from: "2026-01-12T07:00:00.000Z",
      valid_to: "2026-04-12T07:00:00.000Z",
      san_count: 2,
      cert_age_days: 3,
      is_new: true,
      expired: false,
      self_signed: false,
      valid: true,
    },
    lookalike: { brand: "PayPal", technique: "homoglyph", brand_domain: "paypal.com" },
    heuristics: [
      "credential_keywords_in_host",
      "credential_keywords_in_path",
      "password_field",
      "young_domain",
      "very_young_domain",
      "new_certificate",
      "brand_lookalike",
      "safe_browsing_match",
      "virustotal_malicious",
      "virustotal_suspicious",
    ],
    errors: [],
    analyzed_at: MOCK_ANALYZED_AT,
  },

  [MOCK_URLS.shortener]: {
    input: MOCK_URLS.shortener,
    normalized_url: "http://bit.ly/3xyz",
    display_url: "http://bit.ly/3xyz",
    final_url: "https://wallet-unlock-secure.xyz/connect",
    redirect_chain: ["http://bit.ly/3xyz", "https://bit.ly/3xyz", "https://wallet-unlock-secure.xyz/connect"],
    page: {
      hops: [
        { url: "http://bit.ly/3xyz", status: 301, method: "HEAD" },
        { url: "https://bit.ly/3xyz", status: 301, method: "HEAD" },
        { url: "https://wallet-unlock-secure.xyz/connect", status: 200, method: "GET" },
      ],
      final_status: 200,
      content_type: "text/html",
      title: "Wallet Validation - Restore Access",
      has_password_field: true,
      favicon_url: "https://wallet-unlock-secure.xyz/favicon.ico",
    },
    domain: {
      host: "bit.ly",
      host_unicode: "bit.ly",
      registrable: "bit.ly",
      is_ip: false,
      age_days: 5930,
      registrar: "Libyan Spider Network",
      created: "2009-09-30T00:00:00Z",
    },
    final_domain: {
      host: "wallet-unlock-secure.xyz",
      host_unicode: "wallet-unlock-secure.xyz",
      registrable: "wallet-unlock-secure.xyz",
      is_ip: false,
      age_days: 1,
      registrar: "Gname.com Pte. Ltd.",
      created: "2026-01-14T02:40:00Z",
      expires: "2027-01-14T02:40:00Z",
    },
    reputation: {
      safe_browsing: {
        flagged: true,
        matches: [{ threat_type: "SOCIAL_ENGINEERING", platform: "ANY_PLATFORM", url: "https://wallet-unlock-secure.xyz/connect" }],
      },
      virustotal: {
        status: "found",
        malicious: 14,
        suspicious: 1,
        harmless: 50,
        undetected: 29,
        top_engines: ["BitDefender (phishing)", "CRDF (malicious)", "ESET (phishing)", "G-Data (phishing)", "Webroot (malicious)"],
        reputation: -48,
        last_analysis_date: "2026-01-15T08:45:00.000Z",
        permalink: "https://www.virustotal.com/gui/url/aHR0cDovL2JpdC5seS8zeHl6",
      },
      urlscan: { skipped: "disabled" },
    },
    tls: {
      host: "wallet-unlock-secure.xyz",
      issuer: "Google Trust Services",
      subject: "wallet-unlock-secure.xyz",
      valid_from: "2026-01-14T03:00:00.000Z",
      valid_to: "2026-04-14T03:00:00.000Z",
      san_count: 2,
      cert_age_days: 1,
      is_new: true,
      expired: false,
      self_signed: false,
      valid: true,
    },
    lookalike: null,
    heuristics: [
      "plain_http",
      "suspicious_tld",
      "url_shortener",
      "credential_keywords_in_host",
      "cross_domain_redirect",
      "password_field",
      "young_domain",
      "very_young_domain",
      "new_certificate",
      "safe_browsing_match",
      "virustotal_malicious",
      "virustotal_suspicious",
    ],
    errors: [],
    analyzed_at: MOCK_ANALYZED_AT,
  },

  [MOCK_URLS.ssrf]: {
    input: MOCK_URLS.ssrf,
    normalized_url: "https://192.168.1.1/admin",
    display_url: "https://192.168.1.1/admin",
    redirect_chain: ["https://192.168.1.1/admin"],
    page: { hops: [], has_password_field: false, refused: "refused 192.168.1.1: private (RFC1918)" },
    domain: { host: "192.168.1.1", host_unicode: "192.168.1.1", registrable: "192.168.1.1", is_ip: true },
    reputation: {
      safe_browsing: { flagged: false, matches: [] },
      virustotal: { status: "pending", permalink: "https://www.virustotal.com/gui/url/aHR0cHM6Ly8xOTIuMTY4LjEuMS9hZG1pbg" },
      urlscan: { skipped: "not_applicable" },
    },
    tls: { skipped: "ssrf_refused" },
    lookalike: null,
    heuristics: ["ip_literal_host", "private_ip_host", "ssrf_refused"],
    errors: ["redirects: refused 192.168.1.1: private (RFC1918)"],
    analyzed_at: MOCK_ANALYZED_AT,
  },
};

/**
 * MOCK_MODE: deterministic fixtures for the known test URLs, and for any other
 * URL a plausible clean result (local normalization/lookalike heuristics are
 * still computed, since they need no network).
 */
export function mockAnalysis(norm: NormalizedUrl, deps: Pick<UrlAnalysisDeps, "brands">): UrlAnalysis {
  const fixture = FIXTURES[norm.href];
  if (fixture) {
    const copy = structuredClone(fixture);
    return { ...copy, input: norm.input, heuristics: sortHeuristics(copy.heuristics), mock: true };
  }

  const lookalike = norm.is_ip ? null : detectLookalike(norm.host, deps.brands);
  const heuristics = [...norm.heuristics];
  if (lookalike) heuristics.push("brand_lookalike");
  const isHttps = norm.scheme === "https";
  return {
    input: norm.input,
    normalized_url: norm.href,
    display_url: norm.display_url,
    final_url: norm.href,
    redirect_chain: [norm.href],
    page: {
      hops: [{ url: norm.href, status: 200, method: "GET" }],
      final_status: 200,
      content_type: "text/html; charset=utf-8",
      title: norm.host_unicode,
      has_password_field: false,
      favicon_url: new URL("/favicon.ico", norm.href).href,
    },
    domain: {
      host: norm.host,
      host_unicode: norm.host_unicode,
      registrable: norm.registrable,
      is_ip: norm.is_ip,
      ...(norm.is_ip ? {} : { age_days: 3650, registrar: "Mock Registrar, Inc.", created: "2016-01-15T00:00:00Z" }),
    },
    reputation: {
      safe_browsing: { flagged: false, matches: [] },
      virustotal: {
        status: "found",
        malicious: 0,
        suspicious: 0,
        harmless: 62,
        undetected: 32,
        top_engines: [],
        permalink: `https://www.virustotal.com/gui/url/${Buffer.from(norm.href).toString("base64url")}`,
      },
      urlscan: { skipped: "disabled" },
    },
    tls: isHttps
      ? {
          host: norm.host,
          issuer: "Mock Trust Services",
          subject: norm.host,
          valid_from: "2025-11-15T00:00:00.000Z",
          valid_to: "2026-02-13T00:00:00.000Z",
          san_count: 2,
          cert_age_days: 61,
          is_new: false,
          expired: false,
          self_signed: false,
          valid: true,
        }
      : { skipped: "not_applicable" },
    lookalike,
    heuristics: sortHeuristics(heuristics),
    errors: [],
    analyzed_at: MOCK_ANALYZED_AT,
    mock: true,
  };
}
