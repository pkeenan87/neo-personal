import { describe, expect, it } from "vitest";
import { BRANDS, brandId } from "../src/brands.js";
import { registrableOf } from "../src/checks/normalize.js";
import {
  REMOTE_ACCESS_TOOLS,
  PUP_PUBLISHERS,
  SCAM_PAGE_PHRASES,
  SKIP_DOMAINS,
  USER_CONTENT_HOSTS,
  BRAND_LIST,
  findRemoteAccessTool,
  detectionLists,
} from "../src/lists.js";

/** Returns why `source` is outside the JS/Rust `regex` shared subset, or null. Skips escaped characters. */
function violatesSharedRegexSubset(source: string): string | null {
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") {
      const next = source[i + 1] ?? "";
      if (/[1-9]/.test(next)) return "backreference";
      if (next === "k") return "named backreference";
      i++;
      continue;
    }
    if (c === "(" && source[i + 1] === "?") {
      const rest = source.slice(i + 2);
      if (rest.startsWith(":")) continue;
      const named = /^<([A-Za-z_][A-Za-z0-9_]*)>/.exec(rest);
      if (named) continue;
      return "lookaround, inline flag or unsupported group";
    }
  }
  return null;
}

const TOOL_ID_RE = /^[a-z0-9_-]+$/;

// A handful of domains (e.g. "gov.uk") are themselves a full public suffix in tldts's
// data, so `registrableOf` reports no eTLD+1 under them (`registrable: ""`). Such a
// domain has no finer registrable form, so it is its own canonical value here
// (documented exception; `_specs/signals.md` Detection lists / skip-domains.json).
function registrable(domain: string): string {
  const { is_ip, registrable: r } = registrableOf(domain);
  if (is_ip) return domain;
  return r || domain;
}

describe("remote-access-tools.json", () => {
  it("has the 12 seeded tools", () => {
    expect(REMOTE_ACCESS_TOOLS.length).toBe(12);
  });

  it("has unique ids matching ^[a-z0-9_-]+$", () => {
    const ids = REMOTE_ACCESS_TOOLS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(TOOL_ID_RE);
  });

  it("matches the expected shape", () => {
    for (const tool of REMOTE_ACCESS_TOOLS) {
      expect(typeof tool.id).toBe("string");
      expect(typeof tool.name).toBe("string");
      expect(Array.isArray(tool.vendorDomains)).toBe(true);
      expect(Array.isArray(tool.installerPatterns)).toBe(true);
      expect(Array.isArray(tool.windows.publishers)).toBe(true);
      expect(Array.isArray(tool.windows.displayNamePatterns)).toBe(true);
      expect(Array.isArray(tool.windows.serviceNames)).toBe(true);
      expect(Array.isArray(tool.windows.processNames)).toBe(true);
      expect(Array.isArray(tool.macos.bundleIds)).toBe(true);
      expect(Array.isArray(tool.macos.teamIds)).toBe(true);
      expect(Array.isArray(tool.sessionHints)).toBe(true);
    }
  });

  it("compiles every regex (installerPatterns and displayNamePatterns)", () => {
    for (const tool of REMOTE_ACCESS_TOOLS) {
      for (const pattern of tool.installerPatterns) expect(() => new RegExp(pattern, "i")).not.toThrow();
      for (const pattern of tool.windows.displayNamePatterns) expect(() => new RegExp(pattern, "i")).not.toThrow();
    }
  });

  it("keeps every regex in the JS/Rust shared subset", () => {
    const patterns: string[] = [];
    for (const tool of REMOTE_ACCESS_TOOLS) {
      patterns.push(...tool.installerPatterns, ...tool.windows.displayNamePatterns);
      for (const ev of tool.windows.sessionEvidence) if (ev.kind === "log") patterns.push(ev.pattern);
    }
    expect(patterns.length).toBeGreaterThan(0);
    for (const pattern of patterns) {
      expect(() => new RegExp(pattern, "i"), pattern).not.toThrow();
      expect(violatesSharedRegexSubset(pattern), pattern).toBeNull();
    }
  });

  it("the shared-subset check rejects what Rust regex cannot compile", () => {
    for (const bad of ["a(?=b)", "a(?!b)", "(?<=a)b", "(?<!a)b", "(a)\\1", "(?<x>a)\\k<x>", "(?i)abc", "(?P<x>a)", "(?P=x)", "(?s:a)"]) {
      expect(violatesSharedRegexSubset(bad), bad).not.toBeNull();
    }
    expect(violatesSharedRegexSubset("^Incoming\\s.*?\\s(?<peer>\\d{6,12})\\s")).toBeNull();
    expect(violatesSharedRegexSubset("(?:a|b)\\\\1")).toBeNull();
  });

  it("validates sessionEvidence shape", () => {
    const allowedTokens = new Set(["%ProgramData%", "%ProgramFiles%", "%ProgramFiles(x86)%", "%AppData%"]);
    for (const tool of REMOTE_ACCESS_TOOLS) {
      expect(Array.isArray(tool.windows.sessionEvidence), tool.id).toBe(true);
      for (const ev of tool.windows.sessionEvidence) {
        expect(typeof ev.verified, tool.id).toBe("boolean");
        if (ev.checked !== undefined) expect(ev.checked).toMatch(/\S+ \d{4}-\d{2}-\d{2}$/);
        if (ev.kind === "log") {
          expect(ev.path.length).toBeGreaterThan(0);
          for (const token of ev.path.match(/%[^%]*%/g) ?? []) expect(allowedTokens.has(token), `${tool.id}: ${token}`).toBe(true);
          expect(typeof ev.pattern).toBe("string");
        } else if (ev.kind === "eventlog") {
          expect(ev.channel.length).toBeGreaterThan(0);
          expect(Array.isArray(ev.eventIds) && ev.eventIds.every((n) => Number.isInteger(n))).toBe(true);
        } else if (ev.kind === "process") {
          expect(ev.name.length).toBeGreaterThan(0);
        } else {
          throw new Error(`${tool.id}: unknown sessionEvidence kind`);
        }
      }
    }
  });

  it("ships every sessionEvidence candidate unverified until the VM task", () => {
    for (const tool of REMOTE_ACCESS_TOOLS) for (const ev of tool.windows.sessionEvidence) expect(ev.verified, tool.id).toBe(false);
    expect(findRemoteAccessTool("anydesk")?.windows.sessionEvidence).toHaveLength(2);
    expect(findRemoteAccessTool("rustdesk")?.windows.sessionEvidence).toEqual([]);
  });

  it("every vendorDomain equals its own registrable domain", () => {
    for (const tool of REMOTE_ACCESS_TOOLS) {
      for (const domain of tool.vendorDomains) {
        expect(registrable(domain), `${tool.id}: ${domain}`).toBe(domain);
      }
    }
  });

  it("findRemoteAccessTool looks up by id", () => {
    expect(findRemoteAccessTool("anydesk")?.name).toBe("AnyDesk");
    expect(findRemoteAccessTool("not-a-real-tool")).toBeUndefined();
  });
});

describe("pup-publishers.json", () => {
  it("is a short, conservative seed with a reason for every entry", () => {
    expect(PUP_PUBLISHERS.length).toBeGreaterThan(0);
    expect(PUP_PUBLISHERS.length).toBeLessThanOrEqual(20);
    for (const p of PUP_PUBLISHERS) {
      expect(typeof p.reason).toBe("string");
      expect(p.reason.length).toBeGreaterThan(0);
      expect(p.publisher !== undefined || p.sha256 !== undefined).toBe(true);
      if (p.sha256) expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe("scam-page-phrases.json", () => {
  it("has phrases lowercase with lang 'en'", () => {
    expect(SCAM_PAGE_PHRASES.length).toBeGreaterThanOrEqual(20);
    expect(SCAM_PAGE_PHRASES.length).toBeLessThanOrEqual(40);
    for (const p of SCAM_PAGE_PHRASES) {
      expect(p.phrase).toBe(p.phrase.toLowerCase());
      expect(["support_phone_text", "fake_scan"]).toContain(p.kind);
      expect(p.lang).toBe("en");
    }
  });

  it("has both kinds represented", () => {
    const kinds = new Set(SCAM_PAGE_PHRASES.map((p) => p.kind));
    expect(kinds.has("support_phone_text")).toBe(true);
    expect(kinds.has("fake_scan")).toBe(true);
  });

  it("has no duplicate phrases", () => {
    const phrases = SCAM_PAGE_PHRASES.map((p) => p.phrase);
    expect(new Set(phrases).size).toBe(phrases.length);
  });
});

describe("skip-domains.json", () => {
  it("is lowercase, sorted and unique", () => {
    expect(SKIP_DOMAINS.length).toBeGreaterThan(0);
    const sorted = [...SKIP_DOMAINS].sort();
    expect(SKIP_DOMAINS).toEqual(sorted);
    expect(new Set(SKIP_DOMAINS).size).toBe(SKIP_DOMAINS.length);
    for (const d of SKIP_DOMAINS) expect(d).toBe(d.toLowerCase());
  });

  it("every entry equals its own registrable domain", () => {
    for (const d of SKIP_DOMAINS) expect(registrable(d), d).toBe(d);
  });

  it("includes every BRANDS official domain (as its registrable form) except user-content hosts", () => {
    const skip = new Set(SKIP_DOMAINS);
    const userContent = new Set(USER_CONTENT_HOSTS);
    for (const brand of BRANDS) {
      for (const domain of brand.domains) {
        const r = registrable(domain);
        if (userContent.has(r)) continue;
        expect(skip.has(r), `${brand.name}: ${domain} -> ${r}`).toBe(true);
      }
    }
  });

  it("never skips a host that serves pages written by anyone", () => {
    for (const host of USER_CONTENT_HOSTS) expect(SKIP_DOMAINS, host).not.toContain(host);
  });
});

describe("brands (BRAND_LIST)", () => {
  it("has one entry per BRANDS row, in order, with a stable id", () => {
    expect(BRAND_LIST.length).toBe(BRANDS.length);
    for (const [i, entry] of BRAND_LIST.entries()) {
      const brand = BRANDS[i]!;
      expect(entry.id).toBe(brandId(brand.name));
      expect(entry.name).toBe(brand.name);
      expect(entry.domains).toEqual(brand.domains);
      expect(entry.keywords).toEqual(brand.keywords);
    }
  });

  it("has unique ids matching /^[a-z0-9_-]{1,64}$/", () => {
    const ids = BRAND_LIST.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9_-]{1,64}$/);
  });
});

describe("brandId", () => {
  it("lowercases and collapses non-alphanumeric runs to a single dash", () => {
    expect(brandId("PayPal")).toBe("paypal");
    expect(brandId("X (Twitter)")).toBe("x-twitter");
    expect(brandId("E*TRADE")).toBe("e-trade");
  });

  it("trims leading and trailing dashes", () => {
    expect(brandId("--Foo--")).toBe("foo");
    expect(brandId("!Bar!")).toBe("bar");
  });

  it("caps at 64 characters with no trailing dash", () => {
    const id = brandId("a".repeat(100));
    expect(id.length).toBe(64);
    expect(id.endsWith("-")).toBe(false);
  });
});

describe("detectionLists", () => {
  it("returns all five lists", () => {
    const lists = detectionLists();
    expect(lists.remoteAccessTools).toBe(REMOTE_ACCESS_TOOLS);
    expect(lists.pupPublishers).toBe(PUP_PUBLISHERS);
    expect(lists.scamPagePhrases).toBe(SCAM_PAGE_PHRASES);
    expect(lists.skipDomains).toBe(SKIP_DOMAINS);
    expect(lists.brands).toBe(BRAND_LIST);
  });

  it("version is a stable 16-char hex string", () => {
    const v1 = detectionLists().version;
    const v2 = detectionLists().version;
    expect(v1).toBe(v2);
    expect(v1).toMatch(/^[0-9a-f]{16}$/);
  });

  it("version covers brands (changes if the brands list is dropped from the hash input)", async () => {
    const { createHash } = await import("node:crypto");
    // Mirrors lists.ts's private `canonicalize` (stable key order), minus the `brands` key.
    function canonicalize(value: unknown): unknown {
      if (Array.isArray(value)) return value.map(canonicalize);
      if (value !== null && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(value as Record<string, unknown>).sort()) out[key] = canonicalize((value as Record<string, unknown>)[key]);
        return out;
      }
      return value;
    }
    const withoutBrands = JSON.stringify(
      canonicalize({
        remoteAccessTools: REMOTE_ACCESS_TOOLS,
        pupPublishers: PUP_PUBLISHERS,
        scamPagePhrases: SCAM_PAGE_PHRASES,
        skipDomains: SKIP_DOMAINS,
      }),
    );
    const versionWithoutBrands = createHash("sha256").update(withoutBrands, "utf8").digest("hex").slice(0, 16);
    expect(detectionLists().version).not.toBe(versionWithoutBrands);
  });
});
