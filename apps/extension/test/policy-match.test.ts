// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseList, prefixesFor, encodeBin } from "../../../scripts/category-lists/normalize.mjs";
import { binarySearch, decideHost, decodeBin, domainPrefix, hostCandidates, matchesDomainList, type PrefixLookup } from "../lib/policy/match.js";
import { createPrefixLookup } from "../lib/policy/categories.js";
import { MemoryBinStore } from "../lib/policy/store.js";
import { TOP_DOMAINS } from "../lib/policy/topDomains.js";
import { makeBundle } from "./helpers/policy.js";

const NOW = Date.parse("2026-11-03T12:00:00Z");

/** A lookup over an in-memory list per category, built with the same code the build script uses. */
function lookupFor(lists: Record<string, string[]>): PrefixLookup {
  const arrays = Object.fromEntries(Object.entries(lists).map(([c, domains]) => [c, decodeBin(encodeBin(prefixesFor(domains)).buffer.slice(0) as ArrayBuffer)!]));
  return async (category, prefix) => (arrays[category] ? binarySearch(arrays[category]!, prefix) : false);
}

describe("prefix hashing", () => {
  it("agrees with the build script's hash, file encoding and sort order", async () => {
    const domains = ["example.com", "bad.example.org", "xn--80ak6aa92e.com", "a.co.uk"];
    const bin = encodeBin(prefixesFor(domains));
    expect(bin.length).toBe(domains.length * 4);
    const arr = decodeBin(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer)!;
    expect([...arr]).toEqual([...arr].sort((a, b) => a - b));
    for (const d of domains) expect(binarySearch(arr, await domainPrefix(d))).toBe(true);
  });

  it("binary search finds first, last and middle values and nothing else", () => {
    const arr = Uint32Array.from([1, 5, 9, 4_000_000_000, 4_294_967_295]);
    for (const v of arr) expect(binarySearch(arr, v)).toBe(true);
    for (const v of [0, 2, 6, 10, 3_999_999_999]) expect(binarySearch(arr, v)).toBe(false);
    expect(binarySearch(new Uint32Array(0), 1)).toBe(false);
  });
});

describe("hostCandidates", () => {
  it("walks from the host up to the registrable domain, and no further", () => {
    expect(hostCandidates("a.b.example.com")).toEqual(["a.b.example.com", "b.example.com", "example.com"]);
    expect(hostCandidates("WWW.Example.co.uk.")).toEqual(["www.example.co.uk", "example.co.uk"]);
    expect(hostCandidates("example.com")).toEqual(["example.com"]);
  });
  it("treats an IP or an unknown host as itself", () => {
    expect(hostCandidates("192.168.1.10")).toEqual(["192.168.1.10"]);
    expect(hostCandidates("localhost")).toEqual(["localhost"]);
  });
  it("matchesDomainList matches the entry and its subdomains, not look-alike suffixes", () => {
    expect(matchesDomainList("a.example.com", ["example.com"])).toBe(true);
    expect(matchesDomainList("example.com", ["example.com"])).toBe(true);
    expect(matchesDomainList("notexample.com", ["example.com"])).toBe(false);
    expect(matchesDomainList("example.com.evil.net", ["example.com"])).toBe(false);
  });
});

describe("category matching", () => {
  const lookup = lookupFor({ adult: ["badsite.com", "sub.listed.org"], gambling: ["casino.example"] });
  const bundle = makeBundle({ web: { categories: ["adult", "gambling"] } });

  it("blocks a listed domain, its subdomains, and reports the category", async () => {
    expect(await decideHost("badsite.com", bundle, lookup, NOW)).toMatchObject({ blocked: true, category: "adult", domain: "badsite.com", reason: "category" });
    expect(await decideHost("www.cdn.badsite.com", bundle, lookup, NOW)).toMatchObject({ blocked: true, category: "adult", domain: "badsite.com" });
    expect(await decideHost("casino.example", bundle, lookup, NOW)).toMatchObject({ blocked: true, category: "gambling" });
  });

  it("a list entry that is itself a subdomain does not block its parent or siblings", async () => {
    expect((await decideHost("sub.listed.org", bundle, lookup, NOW)).blocked).toBe(true);
    expect((await decideHost("deeper.sub.listed.org", bundle, lookup, NOW)).blocked).toBe(true);
    expect((await decideHost("listed.org", bundle, lookup, NOW)).blocked).toBe(false);
    expect((await decideHost("other.listed.org", bundle, lookup, NOW)).blocked).toBe(false);
  });

  it("only checks the bundle's categories", async () => {
    const onlyGambling = makeBundle({ web: { categories: ["gambling"] } });
    expect((await decideHost("badsite.com", onlyGambling, lookup, NOW)).blocked).toBe(false);
  });

  it("is free of false positives on a fixture of ordinary domains", async () => {
    const big = lookupFor({ adult: Array.from({ length: 2000 }, (_, i) => `listed-${i}.example`) });
    const b = makeBundle({ web: { categories: ["adult"] } });
    let falsePositives = 0;
    for (let i = 0; i < 2000; i++) if ((await decideHost(`ordinary-${i}.test.org`, b, big, NOW)).blocked) falsePositives++;
    // n / 2^32 per lookup is about 5e-7 per host for 2000 entries: none expected in 2000 hosts.
    expect(falsePositives).toBe(0);
    for (let i = 0; i < 2000; i += 199) expect((await decideHost(`listed-${i}.example`, b, big, NOW)).blocked).toBe(true);
  }, 30_000); // hashes every fixture domain against the full category sets: slow on shared CI runners

  it("is not blocked when the category data is not loaded", async () => {
    const lookupNoData = createPrefixLookup(null, new MemoryBinStore());
    expect((await decideHost("badsite.com", bundle, lookupNoData, NOW)).blocked).toBe(false);
  });

  it("never blocks outside Child mode, or when no category is set", async () => {
    expect((await decideHost("badsite.com", makeBundle({ mode: "standard", web: { categories: ["adult"] } }), lookup, NOW)).blocked).toBe(false);
    expect((await decideHost("badsite.com", makeBundle({ mode: "elder" }), lookup, NOW)).blocked).toBe(false);
    expect((await decideHost("badsite.com", makeBundle({ web: { categories: [] } }), lookup, NOW)).blocked).toBe(false);
  });
});

describe("well-known domains (the ones with a DNR rule)", () => {
  it("are blocked without any category data, so the rules, the content script and the block page agree", async () => {
    const noData = createPrefixLookup(null, new MemoryBinStore());
    for (const [category, domains] of Object.entries(TOP_DOMAINS)) {
      const bundle = makeBundle({ web: { categories: [category as keyof typeof TOP_DOMAINS] } });
      for (const domain of domains) {
        expect(await decideHost(domain, bundle, noData, NOW), domain).toMatchObject({ blocked: true, category, domain });
        expect((await decideHost(`www.${domain}`, bundle, noData, NOW)).blocked, `www.${domain}`).toBe(true);
      }
    }
  });
  it("only when their category is blocked, and not when allowed", async () => {
    const noData = createPrefixLookup(null, new MemoryBinStore());
    expect((await decideHost("pornhub.com", makeBundle({ web: { categories: ["gambling"] } }), noData, NOW)).blocked).toBe(false);
    expect((await decideHost("pornhub.com", makeBundle({ web: { categories: ["adult"], allow: ["pornhub.com"] } }), noData, NOW)).blocked).toBe(false);
  });
});

describe("allow precedence", () => {
  const lookup = lookupFor({ adult: ["badsite.com"] });

  it("web.allow overrides a category and the block list, for the entry and its subdomains", async () => {
    const b = makeBundle({ web: { categories: ["adult"], block: ["badsite.com"], allow: ["badsite.com"] } });
    expect((await decideHost("badsite.com", b, lookup, NOW)).blocked).toBe(false);
    expect((await decideHost("www.badsite.com", b, lookup, NOW)).blocked).toBe(false);
  });

  it("a more specific allow only frees that subdomain", async () => {
    const b = makeBundle({ web: { categories: ["adult"], allow: ["ok.badsite.com"] } });
    expect((await decideHost("ok.badsite.com", b, lookup, NOW)).blocked).toBe(false);
    expect((await decideHost("badsite.com", b, lookup, NOW)).blocked).toBe(true);
  });

  it("web.allowOnce overrides while its time has not passed, and not after", async () => {
    const future = new Date(NOW + 3600_000).toISOString();
    const past = new Date(NOW - 1000).toISOString();
    const running = makeBundle({ web: { categories: ["adult"], allowOnce: [{ domain: "badsite.com", until: future }] } });
    const ended = makeBundle({ web: { categories: ["adult"], allowOnce: [{ domain: "badsite.com", until: past }] } });
    expect((await decideHost("badsite.com", running, lookup, NOW)).blocked).toBe(false);
    expect((await decideHost("badsite.com", ended, lookup, NOW)).blocked).toBe(true);
    expect((await decideHost("badsite.com", running, lookup, NOW + 2 * 3600_000)).blocked).toBe(true);
  });

  it("the parent's block list blocks with no category", async () => {
    const b = makeBundle({ web: { block: ["games.example"] } });
    expect(await decideHost("play.games.example", b, lookup, NOW)).toMatchObject({ blocked: true, category: null, domain: "games.example", reason: "block_list" });
  });
});

describe("list normalization feeds the matcher", () => {
  it("a hosts-style source line is matched by the bare hostname", async () => {
    const domains = parseList("0.0.0.0 Tracker.Example.COM\n# c\n");
    const lookup = lookupFor({ social: domains });
    expect((await decideHost("tracker.example.com", makeBundle({ web: { categories: ["social"] } }), lookup, NOW)).blocked).toBe(true);
  });
});
