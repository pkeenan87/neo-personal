import type { PolicyRules, SignalEvent } from "@neo/verdict";
import { PolicyRulesSchema, WEB_CATEGORIES } from "@neo/verdict";
import { describe, expect, it } from "vitest";
import {
  AGE_BANDS,
  ageBand,
  ageBandInfo,
  childDefaults,
  effectivePolicy,
  evaluateSignal,
  type EngineCatalog,
  type EvaluationContext,
  type RecentSignal,
} from "../src/index.js";

// ─── Age bands ─────────────────────────────────────────────────────

describe("ageBand", () => {
  const NOW = new Date("2026-06-15T12:00:00.000Z");

  it("maps age (current year - birth year) onto the three bands, edges included", () => {
    expect(ageBand(2026, NOW)).toBe("under_10"); // 0
    expect(ageBand(2017, NOW)).toBe("under_10"); // 9
    expect(ageBand(2016, NOW)).toBe("10_13"); // 10
    expect(ageBand(2013, NOW)).toBe("10_13"); // 13
    expect(ageBand(2012, NOW)).toBe("14_17"); // 14
    expect(ageBand(2009, NOW)).toBe("14_17"); // 17
  });

  it("assumes 10-13 without a birth year", () => {
    expect(ageBandInfo(null, NOW)).toEqual({ band: "10_13", age: null, assumed: true, adult: false });
    expect(ageBand(undefined, NOW)).toBe("10_13");
    expect(ageBand(Number.NaN, NOW)).toBe("10_13");
  });

  it("treats 18 and over as 14-17 and flags it", () => {
    expect(ageBandInfo(2008, NOW)).toEqual({ band: "14_17", age: 18, assumed: false, adult: true });
    expect(ageBandInfo(1980, NOW)).toMatchObject({ band: "14_17", adult: true });
    expect(ageBandInfo(2009, NOW).adult).toBe(false);
  });

  it("counts a birth year in the future (a zone ahead of UTC) as under 10", () => {
    expect(ageBandInfo(2027, NOW)).toMatchObject({ band: "under_10", age: -1, adult: false });
  });

  it("changes band on 1 January in the household time zone, not UTC", () => {
    // 2025-12-31T23:30Z is already 2026-01-01 in Auckland (UTC+13) but still 2025 in New York.
    const nye = new Date("2025-12-31T23:30:00.000Z");
    expect(ageBand(2016, nye, "Pacific/Auckland")).toBe("10_13"); // 2026 - 2016 = 10
    expect(ageBand(2016, nye, "America/New_York")).toBe("under_10"); // 2025 - 2016 = 9
    expect(ageBand(2016, nye, null)).toBe("under_10"); // no zone reads as UTC: 2025
    expect(ageBand(2016, nye)).toBe("under_10");
    // And the other way: 2026-01-01T03:00Z is still 31 December in Los Angeles.
    const early = new Date("2026-01-01T03:00:00.000Z");
    expect(ageBand(2016, early, "America/Los_Angeles")).toBe("under_10");
    expect(ageBand(2016, early, "UTC")).toBe("10_13");
  });

  it("falls back to UTC for a zone name the runtime does not know", () => {
    expect(ageBand(2016, new Date("2025-12-31T23:30:00.000Z"), "Not/AZone")).toBe("under_10");
  });

  it("lists the bands", () => {
    expect(AGE_BANDS).toEqual(["under_10", "10_13", "14_17"]);
  });
});

// ─── Defaults (the table in _specs/v2-m2-child.md section 3) ───────

describe("childDefaults", () => {
  const days = (weekday: number | null, weekend: number | null) => ({ mon: weekday, tue: weekday, wed: weekday, thu: weekday, fri: weekday, sat: weekend, sun: weekend });

  it("under 10: all ten categories, SafeSearch on, YouTube strict, approval, 1h/2h, 19:30-07:00", () => {
    const d = childDefaults("under_10");
    expect(d.web?.categories).toEqual([...WEB_CATEGORIES]);
    expect(d.web?.categories).toHaveLength(10);
    expect(d.web).toMatchObject({ safeSearch: true, youtubeRestricted: "strict", allow: [], block: [] });
    expect(d.apps).toEqual({ block: [], requireApproval: true, approved: [] });
    expect(d.screenTime).toEqual({ dailyMinutes: days(60, 120), downtime: [{ start: "19:30", end: "07:00" }], warnMinutes: 10, allowDuringDowntime: [] });
  });

  it("10-13: seven categories, moderate, approval, 2h/3h, 21:00-07:00", () => {
    const d = childDefaults("10_13");
    expect(d.web?.categories).toEqual(["adult", "gambling", "weapons", "self_harm", "drugs", "proxy_vpn", "dating"]);
    expect(d.web).toMatchObject({ safeSearch: true, youtubeRestricted: "moderate" });
    expect(d.apps?.requireApproval).toBe(true);
    expect(d.screenTime).toEqual({ dailyMinutes: days(120, 180), downtime: [{ start: "21:00", end: "07:00" }], warnMinutes: 10, allowDuringDowntime: [] });
  });

  it("14-17: five categories, moderate, no approval, no limit, 23:00-06:00", () => {
    const d = childDefaults("14_17");
    expect(d.web?.categories).toEqual(["adult", "gambling", "self_harm", "drugs", "proxy_vpn"]);
    expect(d.web).toMatchObject({ safeSearch: true, youtubeRestricted: "moderate" });
    expect(d.apps?.requireApproval).toBe(false);
    expect(d.screenTime).toEqual({ dailyMinutes: days(null, null), downtime: [{ start: "23:00", end: "06:00" }], warnMinutes: 10, allowDuringDowntime: [] });
  });

  it("every band validates against the policy schema and carries Elder's remote-access and protection rules", () => {
    for (const band of AGE_BANDS) {
      const d = childDefaults(band);
      expect(PolicyRulesSchema.safeParse(d).success).toBe(true);
      expect(d.remote_access).toEqual({ unknownPeerSeverity: "critical", sessionWindowMinutes: 30 });
      expect(d.devices).toEqual({ protectionDisabledSeverity: "high" });
      expect(d.notify?.childRequestsTo).toBe("owners");
    }
  });

  it("returns fresh objects each call", () => {
    const a = childDefaults("under_10");
    a.web!.categories!.pop();
    expect(childDefaults("under_10").web?.categories).toHaveLength(10);
  });
});

describe("effectivePolicy for Child", () => {
  it("picks defaults from the birth year and household zone, and layers win over them", () => {
    const now = new Date("2025-12-31T23:30:00.000Z");
    expect(effectivePolicy({ mode: "child", birthYear: 2016, timeZone: "America/New_York", now }).apps?.requireApproval).toBe(true);
    expect(effectivePolicy({ mode: "child", birthYear: 2016, timeZone: "America/New_York", now }).web?.youtubeRestricted).toBe("strict"); // under 10
    expect(effectivePolicy({ mode: "child", birthYear: 2016, timeZone: "Pacific/Auckland", now }).web?.youtubeRestricted).toBe("moderate"); // 10
    const p = effectivePolicy({
      mode: "child",
      birthYear: 2010,
      now,
      member: { web: { block: ["tiktok.com"] }, screenTime: { dailyMinutes: { mon: 30, sun: null } }, apps: { requireApproval: true } },
      device: { screenTime: { warnMinutes: 5 } },
    });
    expect(p.web?.block).toEqual(["tiktok.com"]);
    expect(p.web?.categories).toEqual(["adult", "gambling", "self_harm", "drugs", "proxy_vpn"]); // 14-17 default kept
    expect(p.screenTime?.dailyMinutes).toEqual({ mon: 30, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null });
    expect(p.screenTime?.warnMinutes).toBe(5);
    expect(p.screenTime?.downtime).toEqual([{ start: "23:00", end: "06:00" }]);
    expect(p.apps?.requireApproval).toBe(true);
  });

  it("birth year and time zone are ignored outside Child mode, and Standard/Elder are unchanged", () => {
    expect(effectivePolicy({ mode: "standard", birthYear: 2016 })).toEqual(effectivePolicy({ mode: "standard" }));
    expect(effectivePolicy({ mode: "elder", birthYear: 2016 }).web).toBeUndefined();
    expect(effectivePolicy({ mode: "standard" }).web).toBeUndefined();
  });

  it("a member layer that fails the schema is skipped whole, so the defaults still protect", () => {
    const p = effectivePolicy({ mode: "child", birthYear: 2016, now: new Date("2026-06-01T00:00:00Z"), member: { web: { block: ["NOT A DOMAIN"] } } });
    expect(p.web?.block).toEqual([]);
  });
});

// ─── Engine rules ──────────────────────────────────────────────────

const NOW = new Date("2026-11-02T15:00:00.000Z");
const MIN = 60_000;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const catalog: EngineCatalog = { vendorDomains: () => [], toolIdForBundle: () => undefined };
const ctx = (recent: RecentSignal[] = []): EvaluationContext => ({ now: NOW, deviceId: "device-1", expectedTools: [], recent, catalog });
const child = effectivePolicy({ mode: "child", birthYear: 2015, timeZone: "UTC", now: NOW }); // 10-13
const child14 = effectivePolicy({ mode: "child", birthYear: 2010, timeZone: "UTC", now: NOW }); // 14-17
const standard = effectivePolicy({ mode: "standard" });
const elder = effectivePolicy({ mode: "elder" });

const blocked = (n: number, category: (typeof WEB_CATEGORIES)[number], offsetMin = 0, domain = "bad.test"): SignalEvent => ({
  id: uuid(n),
  type: "page",
  detector: "web_blocked",
  observedAt: new Date(NOW.getTime() + offsetMin * MIN).toISOString(),
  domain,
  category,
});
const blockRow = (n: number, offsetMin: number, category = "self_harm", over: Partial<RecentSignal> = {}): RecentSignal => ({
  id: uuid(500 + n),
  clientEventId: uuid(n),
  detector: "web_blocked",
  severity: null,
  outcome: "recorded",
  verdictId: null,
  observedAt: new Date(NOW.getTime() + offsetMin * MIN),
  deviceId: "device-1",
  payload: { domain: "bad.test", category },
  ...over,
});
const app = (detector: "app_installed" | "app_blocked"): SignalEvent => ({ id: uuid(20), type: "software", detector, observedAt: NOW.toISOString(), name: "Roblox", signer: "Roblox Corporation", image: "RobloxPlayerBeta.exe" });
const exhausted: SignalEvent = { id: uuid(21), type: "usage", detector: "screen_time_exhausted", observedAt: NOW.toISOString() };
const tamper = (reason: "vpn_app" | "bad_policy_signature" = "vpn_app"): SignalEvent => ({ id: uuid(22), type: "tamper", detector: "tamper_detected", observedAt: NOW.toISOString(), reason });

describe("web_blocked (Child)", () => {
  it("records a single block of any category", () => {
    for (const category of WEB_CATEGORIES) {
      expect(evaluateSignal(child, { event: blocked(1, category) }, ctx())).toMatchObject({ action: "record", kind: null, notifyNow: false, correlations: [] });
    }
  });

  it("raises self_harm_attempts (high, notifyNow) on the third self-harm block in an hour, not the second", () => {
    const first = blockRow(1, -30);
    const second = blockRow(2, -10);
    expect(evaluateSignal(child, { event: blocked(2, "self_harm", -10) }, ctx([first])).action).toBe("record"); // 2 blocks
    const d = evaluateSignal(child, { event: blocked(3, "self_harm") }, ctx([first, second]));
    expect(d).toMatchObject({ action: "incident", kind: "self_harm_attempts", severity: "high", notifyNow: true, verdictLabel: null, correlations: [] });
  });

  it("counts the three across devices", () => {
    const d = evaluateSignal(child, { event: blocked(3, "self_harm") }, ctx([blockRow(1, -30, "self_harm", { deviceId: "other" }), blockRow(2, -20, "self_harm", { deviceId: "third" })]));
    expect(d.kind).toBe("self_harm_attempts");
  });

  it("the window is 60 minutes with inclusive edges", () => {
    const at60 = evaluateSignal(child, { event: blocked(3, "self_harm") }, ctx([blockRow(1, -60), blockRow(2, -30)]));
    expect(at60.action).toBe("incident");
    const at61 = evaluateSignal(child, { event: blocked(3, "self_harm") }, ctx([blockRow(1, -61), blockRow(2, -30)]));
    expect(at61.action).toBe("record");
  });

  it("ignores other categories and non-block rows, and does not count the event twice", () => {
    expect(evaluateSignal(child, { event: blocked(3, "self_harm") }, ctx([blockRow(1, -30, "adult"), blockRow(2, -20, "drugs")])).action).toBe("record");
    expect(evaluateSignal(child, { event: blocked(3, "adult") }, ctx([blockRow(1, -30), blockRow(2, -20)])).action).toBe("record"); // the current block is not self-harm
    const other = blockRow(4, -20, "self_harm", { detector: "payment_page" });
    expect(evaluateSignal(child, { event: blocked(3, "self_harm") }, ctx([blockRow(1, -30), other])).action).toBe("record");
    // The stored row of the event itself (re-evaluation with its signal id) is not a second block.
    expect(evaluateSignal(child, { event: blocked(3, "self_harm"), signalId: uuid(900) }, ctx([blockRow(1, -30), blockRow(3, 0)])).action).toBe("record");
  });

  it("judges a late-arriving older block by the run it belongs to", () => {
    // Blocks at -50, -40 are stored; the event now arriving observed -45 completes a run of three within an hour.
    const d = evaluateSignal(child, { event: blocked(3, "self_harm", -45) }, ctx([blockRow(1, -50), blockRow(2, -40)]));
    expect(d.action).toBe("incident");
    // A fourth block keeps raising (deduped downstream), as long as some three fit in an hour.
    const fourth = evaluateSignal(child, { event: blocked(4, "self_harm", 5) }, ctx([blockRow(1, -50), blockRow(2, -40), blockRow(3, -10)]));
    expect(fourth.action).toBe("incident");
  });

  it("only records under Standard and Elder, which configure no web section", () => {
    const rows = [blockRow(1, -30), blockRow(2, -20)];
    expect(evaluateSignal(standard, { event: blocked(3, "self_harm") }, ctx(rows)).action).toBe("record");
    expect(evaluateSignal(elder, { event: blocked(3, "self_harm") }, ctx(rows)).action).toBe("record");
  });
});

describe("app_installed (Child)", () => {
  it("raises app_approval (medium, notifyNow) when approval is required", () => {
    const d = evaluateSignal(child, { event: app("app_installed") }, ctx());
    expect(d).toMatchObject({ action: "incident", kind: "app_approval", severity: "medium", notifyNow: true, verdictLabel: null });
    expect(d).not.toHaveProperty("notifyAlways");
  });

  it("is recorded for the 14-17 band, and when the parent turns approval off", () => {
    expect(evaluateSignal(child14, { event: app("app_installed") }, ctx()).action).toBe("record");
    const off = effectivePolicy({ mode: "child", birthYear: 2015, now: NOW, member: { apps: { requireApproval: false } } });
    expect(evaluateSignal(off, { event: app("app_installed") }, ctx()).action).toBe("record");
    const on = effectivePolicy({ mode: "child", birthYear: 2010, now: NOW, member: { apps: { requireApproval: true } } });
    expect(evaluateSignal(on, { event: app("app_installed") }, ctx()).kind).toBe("app_approval");
  });

  it("is recorded under Standard and Elder", () => {
    expect(evaluateSignal(standard, { event: app("app_installed") }, ctx()).action).toBe("record");
    expect(evaluateSignal(elder, { event: app("app_installed") }, ctx()).action).toBe("record");
  });
});

describe("app_blocked and screen_time_exhausted (Child)", () => {
  it("are recorded for the digest in every mode", () => {
    for (const policy of [child, child14, standard, elder]) {
      expect(evaluateSignal(policy, { event: app("app_blocked") }, ctx())).toMatchObject({ action: "record", notifyNow: false });
      expect(evaluateSignal(policy, { event: exhausted }, ctx())).toMatchObject({ action: "record", notifyNow: false });
    }
  });
});

describe("tamper_detected", () => {
  it("is a protection_disabled incident (high, notifyNow) in Child and Elder, with the reason as evidence", () => {
    for (const policy of [child, child14, elder]) {
      const d = evaluateSignal(policy, { event: tamper("vpn_app") }, ctx());
      expect(d).toMatchObject({ action: "incident", kind: "protection_disabled", severity: "high", notifyNow: true, reasonCodes: ["tamper_detected", "vpn_app"] });
    }
    expect(evaluateSignal(child, { event: tamper("bad_policy_signature") }, ctx()).reasonCodes).toContain("bad_policy_signature");
  });

  it("is only recorded under Standard", () => {
    expect(evaluateSignal(standard, { event: tamper() }, ctx())).toMatchObject({ action: "record", kind: null, notifyNow: false });
  });

  it("follows the policy's severity when a parent changes it", () => {
    const loud: PolicyRules = { devices: { protectionDisabledSeverity: "critical" } };
    expect(evaluateSignal(effectivePolicy({ mode: "child", now: NOW, member: loud }), { event: tamper() }, ctx()).severity).toBe("critical");
  });
});

describe("remote access in Child mode is as in Elder", () => {
  const session: SignalEvent = { id: uuid(30), type: "remote_session", detector: "remote_access_session", observedAt: NOW.toISOString(), toolId: "anydesk", direction: "incoming", peerId: "stranger" };
  it("rates an unknown tool critical and an unknown peer of an expected tool critical; an unexpected tool install is high", () => {
    expect(evaluateSignal(child, { event: session }, ctx())).toMatchObject({ severity: "critical", kind: "remote_access" });
    const expected = { ...ctx(), expectedTools: [{ toolId: "anydesk", peerIds: ["parent"] }] };
    expect(evaluateSignal(child, { event: session }, expected).severity).toBe("critical");
    const install: SignalEvent = { id: uuid(31), type: "software", detector: "remote_access_tool", observedAt: NOW.toISOString(), toolId: "anydesk", name: "AnyDesk" };
    expect(evaluateSignal(child, { event: install }, ctx())).toMatchObject({ severity: "high", kind: "remote_access" });
  });
});
