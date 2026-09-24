import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeUrl } from "../src/analyzeUrl.js";
import { InMemoryReputationCache, urlAnalysisCacheKey } from "../src/cache.js";
import { checkUrlTool, createCheckUrlTool, URL_ANALYSIS_GUIDANCE } from "../src/checkUrlTool.js";
import { extractUrlIocs } from "../src/iocs.js";
import { MOCK_URLS } from "../src/mock.js";
import { SAFE_BROWSING_ENDPOINT } from "../src/checks/safeBrowsing.js";
import { virusTotalUrlId } from "../src/checks/virustotal.js";
import type { PageResult, UrlAnalysis } from "../src/types.js";
import { fakeLookup, fakeTls, fixture, html, json, redirect, routeFetch, testDeps } from "./helpers.js";

const toolCtx = { tenantId: "t1", userId: "u1", conversationId: "c1" };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("analyzeUrl end to end (mocked network)", () => {
  it("combines all checks for a shortener that lands on a young phishing page", async () => {
    const start = "http://bit.ly/abc";
    const final = "https://paypal-account-verify.top/signin";
    const vtId = virusTotalUrlId(start);
    const fetch = routeFetch({
      "HEAD http://bit.ly/abc": redirect("https://bit.ly/abc", 301),
      "HEAD https://bit.ly/abc": redirect(final, 301),
      [`HEAD ${final}`]: new Response(null, { status: 200 }),
      [`GET ${final}`]: html('<title>PayPal: Log in</title><input type="password">'),
      "https://rdap.org/domain/bit.ly": json({ events: [{ eventAction: "registration", eventDate: "2009-09-30T00:00:00Z" }] }),
      "https://rdap.org/domain/paypal-account-verify.top": json({ events: [{ eventAction: "registration", eventDate: "2026-01-13T00:00:00Z" }] }),
      [`POST ${SAFE_BROWSING_ENDPOINT}?key=g`]: json({ matches: [{ threatType: "SOCIAL_ENGINEERING", platformType: "ANY_PLATFORM", threat: { url: final } }] }),
      [`https://www.virustotal.com/api/v3/urls/${vtId}`]: json(fixture("virustotal-url.json")),
    });
    const lookup = fakeLookup({ "bit.ly": ["67.199.248.10"], "paypal-account-verify.top": ["93.184.215.20"] });
    const tlsConnect = fakeTls({
      authorized: true,
      subject: { CN: "paypal-account-verify.top" },
      issuer: { O: "Let's Encrypt", CN: "R11" },
      valid_from: "Jan 13 00:00:00 2026 GMT",
      valid_to: "Apr 13 00:00:00 2026 GMT",
      subjectaltname: "DNS:paypal-account-verify.top",
    });

    const a = await analyzeUrl(start, { deps: testDeps({ fetch, lookup, tlsConnect, env: { GOOGLE_SAFE_BROWSING_API_KEY: "g", VIRUSTOTAL_API_KEY: "v" } }) });

    expect(a.errors).toEqual([]);
    expect(a.final_url).toBe(final);
    expect(a.redirect_chain).toEqual([start, "https://bit.ly/abc", final]);
    expect(a.domain).toMatchObject({ registrable: "bit.ly", age_days: 5951 });
    expect(a.final_domain).toMatchObject({ registrable: "paypal-account-verify.top", age_days: 2 });
    expect(a.tls).toMatchObject({ host: "paypal-account-verify.top", issuer: "Let's Encrypt", is_new: true, valid: true, san_count: 1 });
    expect(tlsConnect).toHaveBeenCalledWith(expect.objectContaining({ host: "paypal-account-verify.top", address: "93.184.215.20", port: 443 }));
    expect(a.lookalike).toMatchObject({ brand: "PayPal", technique: "brand_with_affix" });
    expect(a.reputation.urlscan).toEqual({ skipped: "disabled" });
    expect(a.heuristics).toEqual(
      expect.arrayContaining([
        "plain_http", "url_shortener", "suspicious_tld", "cross_domain_redirect", "password_field", "young_domain",
        "very_young_domain", "new_certificate", "brand_lookalike", "safe_browsing_match", "virustotal_malicious",
      ]),
    );
    expect(extractUrlIocs(a)).toEqual({
      urls: [start, "https://bit.ly/abc", final],
      domains: ["bit.ly", "paypal-account-verify.top"],
      ips: [],
      hashes: [],
      phone_numbers: [],
    });
  });

  it("marks every keyed check skipped when no API keys are set, and never throws", async () => {
    const fetch = routeFetch({
      "https://example.com/": html("<title>Example Domain</title>"),
      "https://rdap.org/domain/example.com": json({ events: [{ eventAction: "registration", eventDate: "1995-08-14T04:00:00Z" }] }),
    });
    const lookup = fakeLookup({ "example.com": ["93.184.215.14"] });
    const a = await analyzeUrl("https://example.com/", { deps: testDeps({ fetch, lookup, urlscan: true }) });
    expect(a.reputation).toEqual({
      safe_browsing: { skipped: "no_api_key" },
      virustotal: { skipped: "no_api_key" },
      urlscan: { skipped: "no_api_key" },
    });
    expect(a.errors).toEqual([]);
    expect(a.heuristics).toEqual([]);
    expect(a.lookalike).toBeNull();
  });

  it("collects errors from failing checks instead of throwing", async () => {
    const fetch = routeFetch({ "https://rdap.org/domain/example.com": json({}, 500) });
    const lookup = fakeLookup({ "example.com": ["93.184.215.14"] });
    const tlsConnect = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    const a = await analyzeUrl("https://example.com/", { deps: testDeps({ fetch, lookup, tlsConnect }) });
    expect(a.errors).toEqual(expect.arrayContaining([expect.stringMatching(/^redirects: /), "rdap: HTTP 500", "tls: connect ECONNREFUSED"]));
  });

  it("returns an unparseable_url result for garbage input", async () => {
    const a = await analyzeUrl("http://exa mple.com:99999", { deps: testDeps() });
    expect(a.heuristics).toEqual(["unparseable_url"]);
    expect(a.errors[0]).toMatch(/^normalize: /);
  });
});

describe("reputation cache", () => {
  it("returns a cached analysis on the second call without network", async () => {
    const fetch = routeFetch({
      "https://example.com/": html("<title>Example</title>"),
      "https://rdap.org/domain/example.com": json({}),
    });
    const lookup = fakeLookup({ "example.com": ["93.184.215.14"] });
    const cache = new InMemoryReputationCache();
    const setSpy = vi.spyOn(cache, "set");
    const deps = testDeps({ fetch, lookup, cache });

    const first = await analyzeUrl("https://EXAMPLE.com/#x", { deps });
    expect(first.cached).toBeUndefined();
    expect(setSpy).toHaveBeenCalledWith(urlAnalysisCacheKey("https://example.com/"), expect.anything(), 86_400);
    const calls = fetch.mock.calls.length;

    const second = await analyzeUrl("https://example.com/", { deps });
    expect(second.cached).toBe(true);
    expect(fetch.mock.calls.length).toBe(calls);
    expect({ ...second, cached: undefined }).toEqual({ ...first, cached: undefined });
  });

  it("does not cache results that contain errors", async () => {
    const cache = new InMemoryReputationCache();
    const a = await analyzeUrl("https://example.com/", { deps: testDeps({ cache }) });
    expect(a.errors.length).toBeGreaterThan(0);
    expect(cache.size).toBe(0);
  });

  it("expires entries after the TTL", () => {
    let now = 0;
    const cache = new InMemoryReputationCache(10, () => now);
    cache.set("k", { v: 1 }, 60);
    expect(cache.get("k")).toEqual({ v: 1 });
    now = 61_000;
    expect(cache.get("k")).toBeUndefined();
  });
});

describe("MOCK_MODE", () => {
  const noNet = () => testDeps({ fetch: routeFetch({}), lookup: fakeLookup({}), tlsConnect: fakeTls() });

  it("is enabled by env MOCK_MODE=true and uses no network", async () => {
    const deps = noNet();
    const a = await analyzeUrl(MOCK_URLS.clean, { deps: { ...deps, mock: undefined, env: { MOCK_MODE: "true" } } as never });
    expect(a.mock).toBe(true);
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.lookup).not.toHaveBeenCalled();
    expect(deps.tlsConnect).not.toHaveBeenCalled();
  });

  it("returns the clean fixture for example.com", async () => {
    const a = await analyzeUrl("https://example.com/", { deps: { ...noNet(), mock: true } });
    expect(a).toMatchObject({ final_url: "https://example.com/", lookalike: null, heuristics: [], errors: [] });
    expect(a.reputation.safe_browsing).toEqual({ flagged: false, matches: [] });
  });

  it("returns the phishing fixture (lookalike + young domain + password form)", async () => {
    const a = await analyzeUrl(MOCK_URLS.phish, { deps: { ...noNet(), mock: true } });
    expect(a.lookalike).toMatchObject({ brand: "PayPal", technique: "homoglyph" });
    expect(a.domain.age_days).toBeLessThan(30);
    expect((a.page as PageResult).has_password_field).toBe(true);
    expect(a.heuristics).toEqual(expect.arrayContaining(["brand_lookalike", "young_domain", "password_field"]));
  });

  it("returns the shortener fixture that expands to a malicious destination", async () => {
    const a = await analyzeUrl(MOCK_URLS.shortener, { deps: { ...noNet(), mock: true } });
    expect(a.redirect_chain.length).toBeGreaterThan(1);
    expect(a.final_url).not.toContain("bit.ly");
    expect(a.heuristics).toEqual(expect.arrayContaining(["url_shortener", "cross_domain_redirect", "safe_browsing_match", "virustotal_malicious"]));
  });

  it("returns the SSRF-refused fixture for a private IP", async () => {
    const a = await analyzeUrl(MOCK_URLS.ssrf, { deps: { ...noNet(), mock: true } });
    expect(a.heuristics).toEqual(expect.arrayContaining(["private_ip_host", "ssrf_refused"]));
    expect(a.final_url).toBeUndefined();
  });

  it("fixtures agree with the real normalizer and lookalike detector", async () => {
    const { normalizeUrl } = await import("../src/checks/normalize.js");
    const { detectLookalike } = await import("../src/checks/lookalike.js");
    for (const url of Object.values(MOCK_URLS)) {
      const a = await analyzeUrl(url, { deps: { ...noNet(), mock: true } });
      const n = normalizeUrl(url);
      expect(a.normalized_url).toBe(n.href);
      expect(a.heuristics).toEqual(expect.arrayContaining(n.heuristics));
      if (!n.is_ip) expect(a.lookalike ?? null).toEqual(detectLookalike(n.host) ?? (a.final_domain ? detectLookalike(a.final_domain.host) : null));
    }
  });

  it("is deterministic and returns a plausible clean result for other URLs", async () => {
    const a1 = await analyzeUrl("https://some-random-site.org/page", { deps: { ...noNet(), mock: true } });
    const a2 = await analyzeUrl("https://some-random-site.org/page", { deps: { ...noNet(), mock: true } });
    expect(a1).toEqual(a2);
    expect(a1).toMatchObject({ mock: true, errors: [], lookalike: null, heuristics: [] });
    expect(a1.reputation.virustotal).toMatchObject({ status: "found", malicious: 0 });
  });
});

describe("check_url tool", () => {
  it("has a strict, non-destructive definition", () => {
    const d = checkUrlTool.definition;
    expect(d.name).toBe("check_url");
    expect(d.strict).toBe(true);
    expect(d.destructive).toBe(false);
    expect(d.input_schema).toEqual({
      type: "object",
      properties: { url: { type: "string", description: expect.any(String) } },
      required: ["url"],
      additionalProperties: false,
    });
    expect(d.description).toMatch(/untrusted|attacker-controlled/i);
    expect(URL_ANALYSIS_GUIDANCE).toMatch(/insufficient_evidence/);
  });

  it("validates input", async () => {
    const tool = createCheckUrlTool({ deps: { mock: true } });
    await expect(tool.execute({}, toolCtx)).rejects.toThrow();
    await expect(tool.execute({ url: "" }, toolCtx)).rejects.toThrow();
    await expect(tool.execute({ url: "https://example.com", extra: 1 }, toolCtx)).rejects.toThrow();
    await expect(tool.execute("https://example.com", toolCtx)).rejects.toThrow();
  });

  it("returns the UrlAnalysis", async () => {
    const tool = createCheckUrlTool({ deps: { mock: true } });
    const r = (await tool.execute({ url: MOCK_URLS.phish }, toolCtx)) as UrlAnalysis;
    expect(r.normalized_url).toBe(MOCK_URLS.phish);
    expect(r.lookalike?.brand).toBe("PayPal");
  });

  it("default tool honours MOCK_MODE from the environment", async () => {
    vi.stubEnv("MOCK_MODE", "true");
    const r = (await checkUrlTool.execute({ url: MOCK_URLS.ssrf }, toolCtx)) as UrlAnalysis;
    expect(r.mock).toBe(true);
    expect(r.heuristics).toContain("ssrf_refused");
  });
});
