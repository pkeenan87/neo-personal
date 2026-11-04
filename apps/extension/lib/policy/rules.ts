/**
 * Declarative Net Request rules for a Child-mode bundle (`_specs/v2-m2-child.md` section 6). Pure:
 * `buildDnrRules(bundle, now)` returns the complete rule set; the caller replaces every dynamic rule
 * with it on each bundle change, and with nothing when the mode is not Child.
 *
 * Priorities (a higher number wins): block-page redirects 10 < parent allows 20 < SafeSearch
 * redirects 30 < "already safe" allows 31 (they stop the SafeSearch redirect from looping) < the
 * YouTube header 40. The allow rule for `web.allow` / a running `web.allowOnce` therefore beats a
 * block-page redirect but not SafeSearch.
 *
 * Budget: one rule per blocked domain (so the block page can name it), at most `RULE_BUDGET` rules in
 * all. Redirect and modifyHeaders rules are "unsafe" dynamic rules, capped at 5000 by Chrome; the
 * budget leaves room. The parent's block list is added before the top domains, so a truncation
 * drops the top domains first.
 */
import type { PolicyBundle, WebCategory } from "@neo/verdict";
import { activeAllowList, cleanHost } from "./match.js";
import { TOP_DOMAINS } from "./topDomains.js";

export const RULE_BUDGET = 3000;

export const PRIORITY = { block: 10, allow: 20, safeSearch: 30, safeSearchDone: 31, youtube: 40 } as const;

const ID_SAFE_SEARCH = 10; // 10..19 redirects, 20..29 "done" allows
const ID_YOUTUBE = 40;
const ID_ALLOW = 100;
const ID_BLOCK = 1000;

/** A DNR rule as the extension builds it (structurally the `declarativeNetRequest.Rule` both browsers accept). */
export interface DnrRule {
  id: number;
  priority: number;
  action: {
    type: "block" | "redirect" | "allow" | "modifyHeaders";
    redirect?: { extensionPath?: string; transform?: { queryTransform: { addOrReplaceParams: { key: string; value: string }[] } } };
    requestHeaders?: { header: string; operation: "set" | "remove" | "append"; value?: string }[];
  };
  condition: {
    requestDomains?: string[];
    regexFilter?: string;
    resourceTypes?: string[];
  };
}

/** The block page the redirect lands on; `d` is the matched domain and `c` the category (`custom` for the parent's own list). */
export function blockedPagePath(domain: string, category: WebCategory | null): `/blocked.html?${string}` {
  return `/blocked.html?d=${encodeURIComponent(domain)}&c=${category ?? "custom"}`;
}

const SAFE_SEARCH = [
  { key: "safe", value: "active", match: String.raw`^https?://([a-z0-9-]+\.)*google\.[a-z.]{2,6}/search\?`, done: String.raw`^https?://([a-z0-9-]+\.)*google\.[a-z.]{2,6}/search\?(.*&)?safe=active(&|$)` },
  { key: "adlt", value: "strict", match: String.raw`^https?://([a-z0-9-]+\.)*bing\.com/search\?`, done: String.raw`^https?://([a-z0-9-]+\.)*bing\.com/search\?(.*&)?adlt=strict(&|$)` },
  { key: "kp", value: "1", match: String.raw`^https?://([a-z0-9-]+\.)*duckduckgo\.com/\?`, done: String.raw`^https?://([a-z0-9-]+\.)*duckduckgo\.com/\?(.*&)?kp=1(&|$)` },
] as const;

const YOUTUBE_DOMAINS = ["youtube.com", "youtube-nocookie.com", "youtubei.googleapis.com"];
const YOUTUBE_VALUE = { strict: "Strict", moderate: "Moderate" } as const;

export interface BuiltRules {
  rules: DnrRule[];
  /** Epoch ms at which a `web.allowOnce` grant used here runs out: rebuild then. Null when none is running. */
  rebuildAt: number | null;
  /** True when the budget cut some block rules (the content script still covers them). */
  truncated: boolean;
}

export function buildDnrRules(bundle: PolicyBundle, now: number): BuiltRules {
  if (bundle.mode !== "child") return { rules: [], rebuildAt: null, truncated: false };
  const rules: DnrRule[] = [];
  const web = bundle.web;

  if (web.safeSearch) {
    SAFE_SEARCH.forEach((s, i) => {
      rules.push({
        id: ID_SAFE_SEARCH + i,
        priority: PRIORITY.safeSearch,
        action: { type: "redirect", redirect: { transform: { queryTransform: { addOrReplaceParams: [{ key: s.key, value: s.value }] } } } },
        condition: { regexFilter: s.match, resourceTypes: ["main_frame"] },
      });
      rules.push({ id: ID_SAFE_SEARCH + 10 + i, priority: PRIORITY.safeSearchDone, action: { type: "allow" }, condition: { regexFilter: s.done, resourceTypes: ["main_frame"] } });
    });
  }

  if (web.youtubeRestricted !== "off") {
    rules.push({
      id: ID_YOUTUBE,
      priority: PRIORITY.youtube,
      action: { type: "modifyHeaders", requestHeaders: [{ header: "YouTube-Restrict", operation: "set", value: YOUTUBE_VALUE[web.youtubeRestricted] }] },
      condition: { requestDomains: YOUTUBE_DOMAINS, resourceTypes: ["main_frame", "sub_frame", "xmlhttprequest"] },
    });
  }

  // Parent allows: a running allowOnce is in the list, and the rule is rebuilt when the first one ends.
  const allow = [...new Set(activeAllowList(web, now).map(cleanHost))].sort();
  if (allow.length > 0) {
    rules.push({ id: ID_ALLOW, priority: PRIORITY.allow, action: { type: "allow" }, condition: { requestDomains: allow, resourceTypes: ["main_frame"] } });
  }
  const running = (web.allowOnce ?? []).map((g) => Date.parse(g.until)).filter((t) => t > now);
  const rebuildAt = running.length ? Math.min(...running) : null;

  // Block-page redirects: the parent's list first, then the well-known domains of each blocked category.
  const allowSet = new Set(allow);
  const targets: { domain: string; category: WebCategory | null }[] = [];
  const seen = new Set<string>();
  const add = (domain: string, category: WebCategory | null) => {
    const d = cleanHost(domain);
    if (seen.has(d) || allowSet.has(d)) return;
    seen.add(d);
    targets.push({ domain: d, category });
  };
  for (const d of web.block) add(d, null);
  for (const category of web.categories) for (const d of TOP_DOMAINS[category]) add(d, category);

  const room = Math.max(0, RULE_BUDGET - rules.length);
  const kept = targets.slice(0, room);
  kept.forEach((t, i) => {
    rules.push({
      id: ID_BLOCK + i,
      priority: PRIORITY.block,
      action: { type: "redirect", redirect: { extensionPath: blockedPagePath(t.domain, t.category) } },
      condition: { requestDomains: [t.domain], resourceTypes: ["main_frame"] },
    });
  });
  return { rules, rebuildAt, truncated: kept.length < targets.length };
}
