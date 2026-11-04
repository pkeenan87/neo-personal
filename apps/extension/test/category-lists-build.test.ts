// @vitest-environment node
/** Unit tests for scripts/category-lists on small fixtures (no network). */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assemble } from "../../../scripts/category-lists/assemble.mjs";
import { domainPrefix as buildPrefix, encodeBin, normalizeHostLine, parseList, prefixesFor } from "../../../scripts/category-lists/normalize.mjs";
import { decodeBin, domainPrefix } from "../lib/policy/match.js";

describe("normalizeHostLine", () => {
  it("keeps plain hostnames, lowercased", () => {
    expect(normalizeHostLine("Example.COM")).toBe("example.com");
    expect(normalizeHostLine("  sub.example.co.uk  ")).toBe("sub.example.co.uk");
    expect(normalizeHostLine("xn--80ak6aa92e.com")).toBe("xn--80ak6aa92e.com");
  });
  it("strips hosts-file prefixes, wildcards, adblock decoration, trailing dots and inline comments", () => {
    expect(normalizeHostLine("0.0.0.0 ads.example.com")).toBe("ads.example.com");
    expect(normalizeHostLine("127.0.0.1\tads.example.com")).toBe("ads.example.com");
    expect(normalizeHostLine("*.example.com")).toBe("example.com");
    expect(normalizeHostLine("||example.com^")).toBe("example.com");
    expect(normalizeHostLine("example.com.")).toBe("example.com");
    expect(normalizeHostLine("example.com # tracker")).toBe("example.com");
  });
  it("drops comments, blanks, IPs, URLs, ports, single labels and malformed names", () => {
    for (const line of ["", "   ", "# comment", "! adblock comment", "0.0.0.0 0.0.0.0", "192.168.0.1", "localhost", "http://example.com/x", "example.com:8080", "example.com/path", "bad_name.example.com", "-bad.example.com", "ex ample.com", "example.c0m", "a.b", "0.0.0.0 localhost", "two words here"]) {
      expect(normalizeHostLine(line), line).toBeNull();
    }
    expect(normalizeHostLine(`${"a".repeat(64)}.example.com`)).toBeNull();
  });
});

describe("parseList", () => {
  it("dedupes and ignores noise", () => {
    expect(parseList("# Title: x\nExample.com\n0.0.0.0 example.com\n\nb.example.org\r\nnot a host\n")).toEqual(["example.com", "b.example.org"]);
  });
});

describe("prefix arrays and files", () => {
  it("are unique, ascending, and 4 little-endian bytes per domain", () => {
    const p = prefixesFor(["b.example", "a.example", "a.example", "c.example"]);
    expect(p.length).toBe(3);
    expect([...p]).toEqual([...p].sort((a, b) => a - b));
    const bin = encodeBin(p);
    expect(bin.length).toBe(12);
    expect(bin.readUInt32LE(0)).toBe(p[0]);
  });
  it("hash like the extension (SHA-256, first 4 bytes, big-endian)", async () => {
    for (const d of ["example.com", "xn--80ak6aa92e.com", "a.b.example.co.uk"]) {
      expect(await domainPrefix(d)).toBe(buildPrefix(d));
      expect(buildPrefix(d)).toBe(createHash("sha256").update(d).digest().readUInt32BE(0));
    }
    const bin = encodeBin(prefixesFor(["example.com"]));
    expect([...decodeBin(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer)!]).toEqual([buildPrefix("example.com")]);
  });
});

describe("assemble", () => {
  const config = {
    sources: {
      blp: { name: "BLP", repo: "r", commit: "c1", licence: "Unlicense (test)" },
      ut1: { name: "UT1", repo: "r", commit: "c2", licence: "CC BY-SA 4.0" },
    },
    files: { "blp/porn": { source: "blp" }, "blp/facebook": { source: "blp" }, "ut1/social_networks": { source: "ut1" }, "ut1/games": { source: "ut1" } },
    categories: {
      adult: { inputs: ["blp/porn"] },
      social: { inputs: ["blp/facebook", "ut1/social_networks"] },
      games: { inputs: ["ut1/games"] },
      self_harm: { inputs: ["local/self-harm"] },
    },
  };
  const texts: Record<string, string> = {
    "blp/porn": "0.0.0.0 one.example\n0.0.0.0 two.example\n0.0.0.0 one.example\n",
    "blp/facebook": "facebook.example\n",
    "ut1/social_networks": "chat.example\nfacebook.example\n",
    "ut1/games": "game.example\n",
    "local/self-harm": "# nothing yet\n",
  };
  const run = () => assemble(config, (k) => texts[k]!);

  it("prefixes ut1-derived files, keeps BLP-only files plain, and records licences", () => {
    const { manifest } = run();
    const c = manifest.categories;
    expect(c.adult).toMatchObject({ file: "adult.bin", count: 2, licence: "Unlicense (test)" });
    expect(c.social).toMatchObject({ file: "ut1-social.bin", count: 2, licence: "CC BY-SA 4.0" }); // BLP + UT1 merged, deduped after hashing
    expect(c.social!.source).toContain("BLP @ c1");
    expect(c.social!.source).toContain("UT1 @ c2");
    expect(c.games).toMatchObject({ file: "ut1-games.bin", licence: "CC BY-SA 4.0" });
    expect(c.self_harm).toMatchObject({ file: "self_harm.bin", count: 0, licence: "MIT" });
  });
  it("sha256 and count describe the emitted bytes", () => {
    const { files, manifest } = run();
    for (const entry of Object.values(manifest.categories)) {
      const bytes = files.get(entry.file)!;
      expect(bytes.length).toBe(entry.count * 4);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(entry.sha256);
    }
  });
  it("the version is content-addressed: stable for the same input, different when a list changes", () => {
    const before = run().version;
    expect(run().version).toBe(before);
    texts["blp/porn"] += "three.example\n";
    expect(run().version).not.toBe(before);
  });
});
