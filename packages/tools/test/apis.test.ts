import { describe, expect, it } from "vitest";
import { checkRdap, parseRdap } from "../src/checks/rdap.js";
import { checkSafeBrowsing, parseSafeBrowsing, SAFE_BROWSING_ENDPOINT } from "../src/checks/safeBrowsing.js";
import { checkUrlscan } from "../src/checks/urlscan.js";
import { checkVirusTotal, parseVirusTotalReport, virusTotalUrlId } from "../src/checks/virustotal.js";
import { resolveDeps } from "../src/deps.js";
import type { CheckContext, UrlAnalysisDeps } from "../src/types.js";
import { fixture, json, NOW, routeFetch, testDeps } from "./helpers.js";

const ctx = (over: Partial<UrlAnalysisDeps>): CheckContext => ({ deps: resolveDeps(testDeps(over)) });

describe("RDAP", () => {
  it("parses creation date, registrar, status, and age from a fixture", () => {
    const r = parseRdap("paypa1-secure-login.com", fixture("rdap-domain.json"), NOW);
    expect(r).toEqual({
      found: true,
      domain: "paypa1-secure-login.com",
      created: "2026-01-12T08:14:22Z",
      expires: "2027-01-12T08:14:22Z",
      last_changed: "2026-01-12T08:20:01Z",
      registrar: "NameSilo, LLC",
      status: ["client transfer prohibited"],
      age_days: 3,
    });
  });

  it("queries rdap.org and handles 404 as not found", async () => {
    const fetch = routeFetch({
      "https://rdap.org/domain/paypa1-secure-login.com": json(fixture("rdap-domain.json")),
      "https://rdap.org/domain/nope.example": json({ errorCode: 404 }, 404),
    });
    await expect(checkRdap("paypa1-secure-login.com", ctx({ fetch }))).resolves.toMatchObject({ age_days: 3, registrar: "NameSilo, LLC" });
    await expect(checkRdap("nope.example", ctx({ fetch }))).resolves.toEqual({ found: false, domain: "nope.example" });
  });

  it("throws on server errors (collected by the analyzer)", async () => {
    const fetch = routeFetch({ "https://rdap.org/domain/example.com": json({}, 503) });
    await expect(checkRdap("example.com", ctx({ fetch }))).rejects.toThrow("HTTP 503");
  });
});

describe("Google Safe Browsing", () => {
  it("parses matches from a fixture", () => {
    expect(parseSafeBrowsing(fixture("safebrowsing-match.json"))).toEqual({
      flagged: true,
      matches: [
        { threat_type: "SOCIAL_ENGINEERING", platform: "ANY_PLATFORM", url: "https://evil.test/login" },
        { threat_type: "MALWARE", platform: "WINDOWS", url: "https://evil.test/login" },
      ],
    });
    expect(parseSafeBrowsing({})).toEqual({ flagged: false, matches: [] });
  });

  it("skips without a key and sends all threat types for all URLs with a key", async () => {
    const fetch = routeFetch({ [`POST ${SAFE_BROWSING_ENDPOINT}?key=gsb-key`]: json(fixture("safebrowsing-match.json")) });
    await expect(checkSafeBrowsing(["https://evil.test/login"], ctx({ fetch }))).resolves.toEqual({ skipped: "no_api_key" });
    expect(fetch).not.toHaveBeenCalled();

    const r = await checkSafeBrowsing(["https://evil.test/login", "https://evil.test/login", "https://b.test/"], ctx({ fetch, env: { GOOGLE_SAFE_BROWSING_API_KEY: "gsb-key" } }));
    expect(r).toMatchObject({ flagged: true });
    const body = JSON.parse(String((fetch.mock.calls[0]![1] as RequestInit).body)) as { threatInfo: Record<string, unknown> };
    expect(body.threatInfo).toMatchObject({
      threatTypes: ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE", "POTENTIALLY_HARMFUL_APPLICATION"],
      platformTypes: ["ANY_PLATFORM"],
      threatEntries: [{ url: "https://evil.test/login" }, { url: "https://b.test/" }],
    });
  });
});

describe("VirusTotal", () => {
  const url = "https://evil.test/login";
  const id = virusTotalUrlId(url);

  it("uses unpadded base64url ids", () => {
    expect(id).toBe("aHR0cHM6Ly9ldmlsLnRlc3QvbG9naW4");
    expect(virusTotalUrlId("https://example.com/")).not.toMatch(/[=+/]/);
  });

  it("parses counts and top engines from a fixture", () => {
    expect(parseVirusTotalReport(id, fixture("virustotal-url.json"))).toEqual({
      status: "found",
      malicious: 3,
      suspicious: 1,
      harmless: 60,
      undetected: 20,
      top_engines: ["BitDefender (malware)", "ESET (phishing)", "Sophos (phishing)", "Acronis (suspicious)"],
      reputation: -20,
      last_analysis_date: "2026-01-15T10:00:00.000Z",
      permalink: `https://www.virustotal.com/gui/url/${id}`,
    });
  });

  it("skips without a key", async () => {
    await expect(checkVirusTotal(url, ctx({}))).resolves.toEqual({ skipped: "no_api_key" });
  });

  it("gets the report with the api key header", async () => {
    const fetch = routeFetch({ [`GET https://www.virustotal.com/api/v3/urls/${id}`]: json(fixture("virustotal-url.json")) });
    const r = await checkVirusTotal(url, ctx({ fetch, env: { VIRUSTOTAL_API_KEY: "vt-key" } }));
    expect(r).toMatchObject({ status: "found", malicious: 3 });
    expect(new Headers((fetch.mock.calls[0]![1] as RequestInit).headers).get("x-apikey")).toBe("vt-key");
  });

  it("submits unknown URLs and reports pending", async () => {
    const fetch = routeFetch({
      [`GET https://www.virustotal.com/api/v3/urls/${id}`]: json({ error: { code: "NotFoundError" } }, 404),
      "POST https://www.virustotal.com/api/v3/urls": json({ data: { type: "analysis", id: "u-abc-123" } }),
    });
    const r = await checkVirusTotal(url, ctx({ fetch, env: { VIRUSTOTAL_API_KEY: "vt-key" } }));
    expect(r).toEqual({ status: "pending", analysis_id: "u-abc-123", permalink: `https://www.virustotal.com/gui/url/${id}` });
    expect(String((fetch.mock.calls[1]![1] as RequestInit).body)).toBe("url=https%3A%2F%2Fevil.test%2Flogin");
  });

  it("does not submit when submission is disabled", async () => {
    const fetch = routeFetch({ [`GET https://www.virustotal.com/api/v3/urls/${id}`]: json({}, 404) });
    const r = await checkVirusTotal(url, ctx({ fetch, env: { VIRUSTOTAL_API_KEY: "k", VIRUSTOTAL_SUBMIT: "false" } }));
    expect(r).toMatchObject({ status: "pending" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reports rate limiting as an error", async () => {
    const fetch = routeFetch({ [`GET https://www.virustotal.com/api/v3/urls/${id}`]: json({}, 429) });
    await expect(checkVirusTotal(url, ctx({ fetch, env: { VIRUSTOTAL_API_KEY: "k" } }))).rejects.toThrow("rate limited");
  });
});

describe("urlscan.io", () => {
  const uuid = "0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0";

  it("is disabled by default and skips without a key when enabled", async () => {
    await expect(checkUrlscan("https://evil.test/", ctx({}))).resolves.toEqual({ skipped: "disabled" });
    await expect(checkUrlscan("https://evil.test/", ctx({ urlscan: true }))).resolves.toEqual({ skipped: "no_api_key" });
    const viaEnv = resolveDeps({ env: { URLSCAN_ENABLED: "true" } });
    expect(viaEnv.urlscan).toBe(true);
  });

  it("submits a private scan and polls until the result is ready", async () => {
    let polls = 0;
    const fetch = routeFetch({
      "POST https://urlscan.io/api/v1/scan/": json({ uuid, result: `https://urlscan.io/result/${uuid}/` }),
      [`GET https://urlscan.io/api/v1/result/${uuid}/`]: () => (++polls < 3 ? json({ status: 404 }, 404) : json(fixture("urlscan-result.json"))),
    });
    const r = await checkUrlscan("https://evil.test/login", ctx({ fetch, urlscan: true, env: { URLSCAN_API_KEY: "us-key" } }));
    expect(polls).toBe(3);
    expect(JSON.parse(String((fetch.mock.calls[0]![1] as RequestInit).body))).toEqual({ url: "https://evil.test/login", visibility: "private" });
    expect(r).toEqual({
      status: "done",
      uuid,
      report_url: `https://urlscan.io/result/${uuid}/`,
      screenshot_url: `https://urlscan.io/screenshots/${uuid}.png`,
      score: 100,
      malicious: true,
      page: { domain: "evil.test", ip: "93.184.215.14", country: "NL" },
    });
  });

  it("returns pending when polling runs out", async () => {
    const fetch = routeFetch({
      "POST https://urlscan.io/api/v1/scan/": json({ uuid }),
      [`GET https://urlscan.io/api/v1/result/${uuid}/`]: () => json({}, 404),
    });
    const r = await checkUrlscan("https://evil.test/", ctx({ fetch, urlscan: true, urlscanPollMs: 20, env: { URLSCAN_API_KEY: "k" } }));
    expect(r).toMatchObject({ status: "pending", uuid });
  });
});
