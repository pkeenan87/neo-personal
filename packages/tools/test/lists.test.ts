import { describe, expect, it } from "vitest";
import { BRANDS } from "../src/brands.js";
import { registrableOf } from "../src/checks/normalize.js";
import {
  REMOTE_ACCESS_TOOLS,
  PUP_PUBLISHERS,
  SCAM_PAGE_PHRASES,
  SKIP_DOMAINS,
  USER_CONTENT_HOSTS,
  findRemoteAccessTool,
  detectionLists,
} from "../src/lists.js";

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

describe("detectionLists", () => {
  it("returns all four lists", () => {
    const lists = detectionLists();
    expect(lists.remoteAccessTools).toBe(REMOTE_ACCESS_TOOLS);
    expect(lists.pupPublishers).toBe(PUP_PUBLISHERS);
    expect(lists.scamPagePhrases).toBe(SCAM_PAGE_PHRASES);
    expect(lists.skipDomains).toBe(SKIP_DOMAINS);
  });

  it("version is a stable 16-char hex string", () => {
    const v1 = detectionLists().version;
    const v2 = detectionLists().version;
    expect(v1).toBe(v2);
    expect(v1).toMatch(/^[0-9a-f]{16}$/);
  });
});
