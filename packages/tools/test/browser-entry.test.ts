/**
 * `@neo/tools/browser` (`_specs/browser-extension.md`): parity with the Node entry's
 * `detectLookalike`/`toUnicodeHost`-equivalent (`domainToUnicode`), `brandId` cases, and a static
 * check that nothing in `src/browser.ts`'s import graph reaches `node:*`, `undici` or `@neo/core`.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { domainToUnicode, fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { detectLookalike as nodeDetectLookalike } from "../src/checks/lookalike.js";
import { brandId, detectLookalike, normalizeForMatch, registrableDomain, toUnicodeHost } from "../src/browser.js";

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

describe("toUnicodeHost", () => {
  it("round-trips known IDNs", () => {
    expect(toUnicodeHost("xn--pypal-4ve.com")).toBe("pаypal.com"); // Cyrillic а (U+0430)
    expect(toUnicodeHost("xn--mnchen-3ya.de")).toBe("münchen.de");
  });

  it("leaves an already-unicode or plain-ASCII host unchanged", () => {
    expect(toUnicodeHost("paypal.com")).toBe("paypal.com");
    expect(toUnicodeHost("www.example.com")).toBe("www.example.com");
  });

  it("decodes only the xn-- labels of a multi-label host", () => {
    expect(toUnicodeHost("www.xn--pypal-4ve.com")).toBe("www.pаypal.com");
  });

  it("matches node:url's domainToUnicode on a corpus of hosts", () => {
    const corpus = [
      "xn--pypal-4ve.com",
      "xn--mnchen-3ya.de",
      "xn--80ak6aa92e.com", // apple.com homoglyph
      "xn--e1aybc.xn--p1ai",
      "xn--nxasmq6b.com",
      "xn--fiqs8s",
      "xn--wgbh1c",
      "www.xn--pypal-4ve.com",
      "google.com",
      "paypal.de",
      "not-a-real-xn--label",
      "192.168.1.1",
    ];
    for (const host of corpus) expect(toUnicodeHost(host), host).toBe(domainToUnicode(host));
  });
});

describe("registrableDomain", () => {
  it("splits registrable and subdomain", () => {
    expect(registrableDomain("www.amazon.co.uk")).toEqual({ registrable: "amazon.co.uk", subdomain: "www", isIp: false });
    expect(registrableDomain("paypal.com")).toEqual({ registrable: "paypal.com", subdomain: "", isIp: false });
  });

  it("reports an IP literal", () => {
    expect(registrableDomain("203.0.113.7")).toEqual({ registrable: "203.0.113.7", subdomain: "", isIp: true });
    expect(registrableDomain("::1")).toEqual({ registrable: "::1", subdomain: "", isIp: true });
  });

  it("returns null for a host with no recognizable registrable domain", () => {
    expect(registrableDomain("localhost")).toBeNull();
    expect(registrableDomain("")).toBeNull();
  });
});

describe("browser detectLookalike matches the Node entry", () => {
  // Same corpus as test/lookalike.test.ts.
  const negatives = [
    "www.paypal.com", "paypal.com", "accounts.google.com", "mail.google.com", "login.microsoftonline.com", "outlook.live.com",
    "www.amazon.co.uk", "smile.amazon.com", "appleid.apple.com", "www.icloud.com", "secure.chase.com", "github.com",
    "example.com", "wikipedia.org", "stackoverflow.com", "amazing.com", "pineapple.com", "purchase.com", "group-ups.com",
    "nytimes.com", "bbc.co.uk", "google.de", "paypal.de", "cloudflare.com", "shopping.com", "192.168.1.1",
  ];
  const positives: [string, string, string][] = [
    ["paypa1-secure-login.com", "PayPal", "homoglyph"],
    ["xn--pypal-4ve.com", "PayPal", "homoglyph"],
    ["rnicrosoft.com", "Microsoft", "homoglyph"],
    ["arnazon.com", "Amazon", "homoglyph"],
    ["g00gle.com", "Google", "homoglyph"],
    ["1inkedin.com", "LinkedIn", "homoglyph"],
    ["vvellsfargo.com", "Wells Fargo", "homoglyph"],
    ["netfiix.com", "Netflix", "homoglyph"],
    ["micosoft.com", "Microsoft", "typosquat"],
    ["microsfot.com", "Microsoft", "typosquat"],
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
  ];

  it.each(negatives)("%s: both null", (host) => {
    expect(detectLookalike(host)).toBeNull();
    expect(nodeDetectLookalike(host)).toBeNull();
  });

  it.each(positives)("%s -> %s: identical result", (host) => {
    expect(detectLookalike(host)).toEqual(nodeDetectLookalike(host));
  });

  it("is literally the same function (one implementation, two entry points)", () => {
    expect(detectLookalike).toBe(nodeDetectLookalike);
  });
});

describe("normalizeForMatch (re-exported)", () => {
  it("lowercases and folds curly quotes", () => {
    expect(normalizeForMatch("Call Micro’soft Support")).toBe("call micro'soft support");
  });
});

describe("brandId", () => {
  it("lowercases and collapses non-alphanumeric runs to a single dash", () => {
    expect(brandId("PayPal")).toBe("paypal");
    expect(brandId("X (Twitter)")).toBe("x-twitter");
  });

  it("trims leading and trailing dashes and caps at 64 chars", () => {
    expect(brandId("--Foo--")).toBe("foo");
    expect(brandId("a".repeat(100)).length).toBe(64);
  });
});

describe("src/browser.ts's import graph", () => {
  const FORBIDDEN = [/^node:/, /^undici$/, /^undici\//, /^@neo\/core$/, /^@neo\/core\//];

  /** Every `import`/`export ... from "specifier"` line (one statement per line, this repo's style). */
  function specifiersOf(source: string): string[] {
    const specifiers: string[] = [];
    for (const line of source.split("\n")) {
      const m = /^\s*(?:import|export)\b.*\bfrom\s*["']([^"']+)["']/.exec(line);
      if (m) specifiers.push(m[1]!);
    }
    return [...new Set(specifiers)];
  }

  function resolveRelative(fromFile: string, specifier: string): string | null {
    if (!specifier.startsWith(".")) return null; // bare package specifier, not a src file
    const withoutExt = specifier.replace(/\.js$/, "");
    return resolve(dirname(fromFile), `${withoutExt}.ts`);
  }

  function walk(file: string, seen: Set<string>, bareSpecifiers: Set<string>): void {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const spec of specifiersOf(source)) {
      if (spec.endsWith(".json")) continue; // data import, not a module to recurse into
      const relPath = resolveRelative(file, spec);
      if (relPath) {
        walk(relPath, seen, bareSpecifiers);
      } else {
        bareSpecifiers.add(spec);
      }
    }
  }

  it("never imports node:*, undici or @neo/core, directly or transitively", () => {
    const entry = join(SRC_DIR, "browser.ts");
    const seen = new Set<string>();
    const bareSpecifiers = new Set<string>();
    walk(entry, seen, bareSpecifiers);

    // Sanity: the walk actually visited more than just the entry file, and saw at least one
    // legitimate bare specifier (tldts), so a broken specifiersOf/resolveRelative would be caught.
    expect(seen.size).toBeGreaterThan(1);
    expect(bareSpecifiers.has("tldts")).toBe(true);

    const forbiddenHits = [...bareSpecifiers].filter((s) => FORBIDDEN.some((re) => re.test(s)));
    expect(forbiddenHits, `forbidden specifiers reachable from browser.ts: ${forbiddenHits.join(", ")}`).toEqual([]);
  });
});
