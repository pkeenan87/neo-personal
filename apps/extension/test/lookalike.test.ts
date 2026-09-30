import { describe, expect, it } from "vitest";
import { evaluateLookalike, isSendableLookalikeHit } from "../lib/detectors/lookalike.js";
import { listsSnapshot } from "../lib/listsSnapshot.js";

const brands = listsSnapshot.brands;
const NO_SKIPS: readonly string[] = [];

describe("evaluateLookalike", () => {
  it("flags punycode plus a lookalike technique (typosquat collapses to lookalike_skeleton)", () => {
    const evaluation = evaluateLookalike("xn--pypal-9nd.com", brands, NO_SKIPS);
    expect(evaluation).not.toBeNull();
    expect(evaluation!.indicators).toEqual(expect.arrayContaining(["password_field", "punycode", "lookalike_skeleton"]));
    expect(evaluation!.brand).toBe("paypal");
    expect(isSendableLookalikeHit(evaluation!)).toBe(true);
  });

  it("flags brand_in_subdomain for a brand name planted in an unrelated subdomain", () => {
    const evaluation = evaluateLookalike("paypal.trusted-family-site.example", brands, NO_SKIPS);
    expect(evaluation).not.toBeNull();
    expect(evaluation!.indicators).toEqual(["password_field", "brand_in_subdomain"]);
    expect(evaluation!.brand).toBe("paypal");
  });

  it("flags lookalike_skeleton (not punycode) for an ordinary ASCII brand-plus-affix host", () => {
    const evaluation = evaluateLookalike("paypal-secure-login.com", brands, NO_SKIPS);
    expect(evaluation).not.toBeNull();
    expect(evaluation!.indicators).toEqual(["password_field", "lookalike_skeleton"]);
    expect(evaluation!.indicators).not.toContain("punycode");
  });

  it("suppresses the heuristic for a domain in skipDomains, even though it would otherwise match", () => {
    const evaluation = evaluateLookalike("paypal.trusted-family-site.example", brands, ["trusted-family-site.example"]);
    expect(evaluation).toBeNull();
  });

  it("finds no lookalike hit on a brand's own real domain (password field alone, not sendable)", () => {
    const evaluation = evaluateLookalike("paypal.com", brands, NO_SKIPS);
    expect(evaluation).not.toBeNull();
    expect(evaluation!.indicators).toEqual(["password_field"]);
    expect(evaluation!.brand).toBeUndefined();
    expect(isSendableLookalikeHit(evaluation!)).toBe(false);
  });

  it("password field alone (no brand match) is never sendable", () => {
    const evaluation = evaluateLookalike("my-family-recipe-blog.example", brands, NO_SKIPS);
    expect(evaluation).not.toBeNull();
    expect(evaluation!.indicators).toEqual(["password_field"]);
    expect(evaluation!.brand).toBeUndefined();
    expect(isSendableLookalikeHit(evaluation!)).toBe(false);
  });

  it("returns null for a host with no recognizable registrable domain (an IP literal)", () => {
    expect(evaluateLookalike("192.0.2.10", brands, NO_SKIPS)).toBeNull();
  });
});
