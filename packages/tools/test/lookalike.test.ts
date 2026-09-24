import { describe, expect, it } from "vitest";
import { BRANDS } from "../src/brands.js";
import { damerauLevenshtein, detectLookalike, skeleton } from "../src/checks/lookalike.js";

describe("brand list", () => {
  it("bundles roughly 150 brands", () => {
    expect(BRANDS.length).toBeGreaterThanOrEqual(140);
    for (const b of BRANDS) expect(b.domains.length).toBeGreaterThan(0);
  });
});

describe("detectLookalike negatives", () => {
  it.each([
    "www.paypal.com", "paypal.com", "accounts.google.com", "mail.google.com", "login.microsoftonline.com", "outlook.live.com",
    "www.amazon.co.uk", "smile.amazon.com", "appleid.apple.com", "www.icloud.com", "secure.chase.com", "github.com",
    "example.com", "wikipedia.org", "stackoverflow.com", "amazing.com", "pineapple.com", "purchase.com", "group-ups.com",
    "nytimes.com", "bbc.co.uk", "google.de", "paypal.de", "cloudflare.com", "shopping.com", "192.168.1.1",
  ])("%s is not flagged", (host) => {
    expect(detectLookalike(host)).toBeNull();
  });
});

describe("detectLookalike positives", () => {
  it.each([
    ["paypa1-secure-login.com", "PayPal", "homoglyph"],
    ["xn--pypal-4ve.com", "PayPal", "homoglyph"], // Cyrillic a
    ["rnicrosoft.com", "Microsoft", "homoglyph"], // rn -> m
    ["arnazon.com", "Amazon", "homoglyph"],
    ["g00gle.com", "Google", "homoglyph"], // 0 -> o
    ["1inkedin.com", "LinkedIn", "homoglyph"], // 1 -> l
    ["vvellsfargo.com", "Wells Fargo", "homoglyph"], // vv -> w
    ["netfiix.com", "Netflix", "homoglyph"],
    ["micosoft.com", "Microsoft", "typosquat"],
    ["microsfot.com", "Microsoft", "typosquat"], // transposition
    ["faceboook.com", "Meta", "typosquat"],
    ["coinbsae.com", "Coinbase", "typosquat"],
    ["paypal.com.secure-login.xyz", "PayPal", "brand_in_subdomain"],
    ["appleid.verify-account.info", "Apple", "brand_in_subdomain"],
    ["chase.com.alerts-center.io", "Chase", "brand_in_subdomain"],
    ["paypal-verify.com", "PayPal", "brand_with_affix"],
    ["appleidsupport.net", "Apple", "brand_with_affix"],
    ["usps-parcel-tracking.com", "USPS", "brand_with_affix"],
    ["chase-alerts.com", "Chase", "brand_with_affix"],
    ["paypal.xyz", "PayPal", "tld_swap"],
    ["netflix.top", "Netflix", "tld_swap"],
    ["coinbase.net", "Coinbase", "tld_swap"],
  ])("%s -> %s via %s", (host, brand, technique) => {
    expect(detectLookalike(host)).toMatchObject({ brand, technique });
  });

  it("supports caller-supplied brands (e.g. the user's own domains)", () => {
    const brands = [{ name: "Acme Corp", domains: ["acmecorp.com"], keywords: ["acmecorp"] }];
    expect(detectLookalike("acmec0rp.com", brands)).toMatchObject({ brand: "Acme Corp", technique: "homoglyph" });
    expect(detectLookalike("mail.acmecorp.com", brands)).toBeNull();
  });
});

describe("helpers", () => {
  it("skeleton folds visual tricks", () => {
    expect(skeleton("rnicrosoft")).toBe(skeleton("microsoft"));
    expect(skeleton("vvells")).toBe(skeleton("wells"));
    expect(skeleton("pаypal")).toBe(skeleton("paypal"));
    expect(skeleton("pàypal")).toBe(skeleton("paypal"));
  });

  it("damerauLevenshtein counts transpositions as one edit", () => {
    expect(damerauLevenshtein("microsoft", "microsfot")).toBe(1);
    expect(damerauLevenshtein("amazon", "amazing")).toBe(2);
    expect(damerauLevenshtein("", "abc")).toBe(3);
    expect(damerauLevenshtein("same", "same")).toBe(0);
  });
});
