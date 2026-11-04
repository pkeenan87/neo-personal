// @vitest-environment node
import { describe, expect, it } from "vitest";
import { RULE_BUDGET, PRIORITY, buildDnrRules, blockedPagePath } from "../lib/policy/rules.js";
import { TOP_DOMAINS } from "../lib/policy/topDomains.js";
import { makeBundle } from "./helpers/policy.js";

const NOW = Date.parse("2026-11-03T12:00:00Z");

describe("DNR rules from a bundle", () => {
  it("builds nothing unless the mode is child", () => {
    for (const mode of ["standard", "elder"] as const) {
      const built = buildDnrRules(makeBundle({ mode, web: { safeSearch: true, youtubeRestricted: "strict", block: ["a.example"], categories: ["adult"] } }), NOW);
      expect(built.rules).toEqual([]);
    }
  });

  it("builds a block-page redirect per blocked domain, the parent's list first", () => {
    const { rules } = buildDnrRules(makeBundle({ web: { block: ["games.example"], categories: ["gambling"] } }), NOW);
    const redirects = rules.filter((r) => r.action.type === "redirect" && r.action.redirect?.extensionPath);
    expect(redirects[0]!.action.redirect!.extensionPath).toBe(blockedPagePath("games.example", null));
    expect(redirects[0]!.action.redirect!.extensionPath).toBe("/blocked.html?d=games.example&c=custom");
    expect(redirects[0]!.condition).toMatchObject({ requestDomains: ["games.example"], resourceTypes: ["main_frame"] });
    expect(redirects.some((r) => r.action.redirect!.extensionPath === blockedPagePath("bet365.com", "gambling"))).toBe(true);
    expect(redirects.every((r) => r.priority === PRIORITY.block)).toBe(true);
  });

  it("adds SafeSearch redirects for Google, Bing and DuckDuckGo with idempotent 'already safe' allows", () => {
    const { rules } = buildDnrRules(makeBundle({ web: { safeSearch: true } }), NOW);
    const redirects = rules.filter((r) => r.action.redirect?.transform);
    const params = redirects.flatMap((r) => r.action.redirect!.transform!.queryTransform.addOrReplaceParams);
    expect(params).toEqual([
      { key: "safe", value: "active" },
      { key: "adlt", value: "strict" },
      { key: "kp", value: "1" },
    ]);
    const allows = rules.filter((r) => r.action.type === "allow");
    expect(allows).toHaveLength(3);
    for (const r of redirects) expect(allows.every((a) => a.priority > r.priority)).toBe(true);
    // The patterns are plain JS-compatible and RE2-safe (no lookahead or backreferences).
    const google = redirects[0]!.condition.regexFilter!;
    const googleDone = allows[0]!.condition.regexFilter!;
    expect(new RegExp(google).test("https://www.google.com/search?q=cats")).toBe(true);
    expect(new RegExp(google).test("https://www.google.co.uk/search?q=cats")).toBe(true);
    expect(new RegExp(google).test("https://example.com/search?q=cats")).toBe(false);
    expect(new RegExp(googleDone).test("https://www.google.com/search?q=cats&safe=active")).toBe(true);
    expect(new RegExp(googleDone).test("https://www.google.com/search?q=cats&safe=off")).toBe(false);
    expect(new RegExp(redirects[2]!.condition.regexFilter!).test("https://duckduckgo.com/?q=cats")).toBe(true);
    for (const r of rules) expect(r.condition.regexFilter ?? "").not.toMatch(/\(\?[=!<]|\\[1-9]/);
  });

  it("sets the YouTube-Restrict header per level, and none when off", () => {
    const header = (level: "off" | "moderate" | "strict") =>
      buildDnrRules(makeBundle({ web: { youtubeRestricted: level } }), NOW).rules.find((r) => r.action.type === "modifyHeaders")?.action.requestHeaders;
    expect(header("strict")).toEqual([{ header: "YouTube-Restrict", operation: "set", value: "Strict" }]);
    expect(header("moderate")).toEqual([{ header: "YouTube-Restrict", operation: "set", value: "Moderate" }]);
    expect(header("off")).toBeUndefined();
  });

  it("gives web.allow and a running web.allowOnce a higher-priority allow rule, and skips redirects for them", () => {
    const until = new Date(NOW + 1800_000).toISOString();
    const ended = new Date(NOW - 1).toISOString();
    const built = buildDnrRules(makeBundle({ web: { block: ["a.example", "b.example", "c.example"], allow: ["a.example"], allowOnce: [{ domain: "b.example", until }, { domain: "c.example", until: ended }] } }), NOW);
    const allow = built.rules.find((r) => r.id === 100)!;
    expect(allow.priority).toBeGreaterThan(PRIORITY.block);
    expect(allow.condition.requestDomains).toEqual(["a.example", "b.example"]);
    const redirected = built.rules.filter((r) => r.action.redirect?.extensionPath).map((r) => r.condition.requestDomains![0]);
    expect(redirected).toEqual(["c.example"]); // the ended grant is blocked again
    expect(built.rebuildAt).toBe(Date.parse(until)); // rebuild when the running one ends
  });

  it("keeps SafeSearch above the parent allow rule (allowing google.com does not turn SafeSearch off)", () => {
    expect(PRIORITY.safeSearch).toBeGreaterThan(PRIORITY.allow);
    expect(PRIORITY.youtube).toBeGreaterThan(PRIORITY.allow);
  });

  it("stays within the rule budget and says when it truncated", () => {
    const block = Array.from({ length: RULE_BUDGET * 2 }, (_, i) => `site-${i}.example`);
    const built = buildDnrRules(makeBundle({ web: { block, categories: ["adult"], safeSearch: true, youtubeRestricted: "strict" } }), NOW);
    expect(built.rules.length).toBeLessThanOrEqual(RULE_BUDGET);
    expect(built.truncated).toBe(true);
    expect(new Set(built.rules.map((r) => r.id)).size).toBe(built.rules.length);
  });

  it("a realistic bundle is far below the budget and has unique ids", () => {
    const all = Object.keys(TOP_DOMAINS) as (keyof typeof TOP_DOMAINS)[];
    const built = buildDnrRules(makeBundle({ web: { categories: all, safeSearch: true, youtubeRestricted: "moderate", block: ["x.example"], allow: ["y.example"] } }), NOW);
    expect(built.rules.length).toBeLessThan(200);
    expect(built.truncated).toBe(false);
    expect(new Set(built.rules.map((r) => r.id)).size).toBe(built.rules.length);
  });
});
