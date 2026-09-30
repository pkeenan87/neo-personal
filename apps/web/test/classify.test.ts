// @vitest-environment node
/**
 * Unit tests for lib/server/signals/classify.ts (_specs/browser-extension.md "Server
 * changes"): the pure dangerous/suspicious/unknown/no_known_problems mapping shared by the
 * on-demand check route and the lookalike-login escalation.
 */
import type { UrlAnalysis } from "@neo/tools";
import { describe, expect, it } from "vitest";
import { classifyUrlAnalysis } from "@/lib/server/signals/classify";

function analysis(overrides: Partial<UrlAnalysis> = {}): UrlAnalysis {
  return {
    input: "https://example.test/",
    normalized_url: "https://example.test/",
    display_url: "https://example.test/",
    redirect_chain: ["https://example.test/"],
    domain: { host: "example.test", host_unicode: "example.test", registrable: "example.test", is_ip: false },
    reputation: {},
    lookalike: null,
    heuristics: [],
    errors: [],
    analyzed_at: "2026-01-15T12:00:00.000Z",
    ...overrides,
  };
}

describe("classifyUrlAnalysis", () => {
  it("dangerous: Safe Browsing flags it", () => {
    const r = classifyUrlAnalysis(analysis({ reputation: { safe_browsing: { flagged: true, matches: [] } } }));
    expect(r.rating).toBe("dangerous");
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it("dangerous: urlscan calls it malicious", () => {
    const r = classifyUrlAnalysis(analysis({ reputation: { urlscan: { status: "done", uuid: "x", report_url: "x", malicious: true } } }));
    expect(r.rating).toBe("dangerous");
  });

  it("dangerous: 3+ VirusTotal engines flag it malicious", () => {
    const r = classifyUrlAnalysis(
      analysis({
        reputation: {
          virustotal: { status: "found", malicious: 3, suspicious: 0, harmless: 10, undetected: 5, top_engines: [], permalink: "x" },
        },
      }),
    );
    expect(r.rating).toBe("dangerous");
  });

  it("suspicious: a brand lookalike", () => {
    const r = classifyUrlAnalysis(analysis({ lookalike: { brand: "PayPal", technique: "homoglyph", brand_domain: "paypal.com" } }));
    expect(r.rating).toBe("suspicious");
    expect(r.reasons[0]).toContain("PayPal");
  });

  it("suspicious: a domain registered less than 30 days ago", () => {
    const r = classifyUrlAnalysis(analysis({ heuristics: ["young_domain"] }));
    expect(r.rating).toBe("suspicious");
  });

  it("suspicious: 1-2 VirusTotal engines flag it malicious", () => {
    const r = classifyUrlAnalysis(
      analysis({
        reputation: {
          virustotal: { status: "found", malicious: 2, suspicious: 0, harmless: 10, undetected: 5, top_engines: [], permalink: "x" },
        },
      }),
    );
    expect(r.rating).toBe("suspicious");
  });

  it("unknown: every reputation source was skipped or errored, with no lookalike or heuristic decision", () => {
    const r = classifyUrlAnalysis(
      analysis({ reputation: { safe_browsing: { skipped: "no_api_key" }, virustotal: { skipped: "no_api_key" }, urlscan: { skipped: "disabled" } } }),
    );
    expect(r.rating).toBe("unknown");
  });

  it("unknown: reputation entirely absent (never even attempted)", () => {
    const r = classifyUrlAnalysis(analysis());
    expect(r.rating).toBe("unknown");
  });

  it("no_known_problems: reputation checked and clean", () => {
    const r = classifyUrlAnalysis(
      analysis({
        reputation: {
          safe_browsing: { flagged: false, matches: [] },
          virustotal: { status: "found", malicious: 0, suspicious: 0, harmless: 68, undetected: 26, top_engines: [], permalink: "x" },
          urlscan: { skipped: "disabled" },
        },
      }),
    );
    expect(r).toEqual({ rating: "no_known_problems", reasons: [] });
  });
});
