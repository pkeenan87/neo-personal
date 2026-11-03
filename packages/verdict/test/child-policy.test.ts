import { describe, expect, it } from "vitest";
import {
  AppRefSchema,
  MAX_DOWNTIME_WINDOWS,
  MAX_POLICY_APP_REFS,
  MAX_POLICY_DOMAINS,
  PolicyRulesSchema,
  SIGNAL_DETECTORS,
  SignalEventSchema,
  TAMPER_REASONS,
  WEB_CATEGORIES,
  parseSignalEvent,
} from "../src/index.js";

const ok = (rules: unknown) => PolicyRulesSchema.safeParse(rules).success;
const web = (w: unknown) => ok({ web: w });
const st = (s: unknown) => ok({ screenTime: s });
const domains = (n: number) => Array.from({ length: n }, (_, i) => `site${i}.example.com`);

describe("PolicyRulesSchema: web", () => {
  it("accepts a full section, every category and the three YouTube levels", () => {
    expect(web({ categories: [...WEB_CATEGORIES], safeSearch: true, youtubeRestricted: "strict", allow: ["school.edu"], block: ["tiktok.com", "a.b.example.co.uk"] })).toBe(true);
    for (const level of ["off", "moderate", "strict"]) expect(web({ youtubeRestricted: level })).toBe(true);
    expect(web({})).toBe(true);
  });

  it("rejects an unknown or repeated category and an unknown YouTube level", () => {
    expect(WEB_CATEGORIES).toHaveLength(10);
    expect(web({ categories: ["news"] })).toBe(false);
    expect(web({ categories: ["adult", "adult"] })).toBe(false);
    expect(web({ youtubeRestricted: "extreme" })).toBe(false);
    expect(web({ safeSearch: "yes" })).toBe(false);
  });

  it("rejects domains that are not lowercase registrable-looking hostnames", () => {
    for (const bad of ["Example.com", "example", "example.com/path", "http://example.com", "exa mple.com", "example.com:80", "-bad.com", "bad-.com", "a..com", ".example.com", "192.168.0.1", "example.123", "user@example.com", "*.example.com", ""]) {
      expect(web({ block: [bad] }), bad).toBe(false);
      expect(web({ allow: [bad] }), bad).toBe(false);
    }
    expect(web({ block: ["xn--pypal-4ve.com"] })).toBe(true);
    expect(web({ block: [`${"a".repeat(63)}.com`] })).toBe(true);
    expect(web({ block: [`${"a".repeat(64)}.com`] })).toBe(false);
    expect(web({ block: [`${"a.".repeat(130)}com`] })).toBe(false); // over 253 characters
  });

  it("limits each list to 200 domains", () => {
    expect(MAX_POLICY_DOMAINS).toBe(200);
    expect(web({ allow: domains(200), block: domains(200) })).toBe(true);
    expect(web({ allow: domains(201) })).toBe(false);
    expect(web({ block: domains(201) })).toBe(false);
  });
});

describe("PolicyRulesSchema: apps", () => {
  it("accepts signer and image, an image alone, a signer alone, and a bundle id", () => {
    expect(AppRefSchema.safeParse({ signer: "Roblox Corporation", image: "RobloxPlayerBeta.exe" }).success).toBe(true);
    expect(AppRefSchema.safeParse({ image: "game.exe" }).success).toBe(true);
    expect(AppRefSchema.safeParse({ signer: "Epic Games, Inc." }).success).toBe(true);
    expect(AppRefSchema.safeParse({ bundleId: "com.roblox.RobloxPlayer" }).success).toBe(true);
  });

  it("rejects an empty app, a path, mixed shapes, a bad bundle id and over-long values", () => {
    expect(AppRefSchema.safeParse({}).success).toBe(false);
    expect(AppRefSchema.safeParse({ image: "C:\\Games\\game.exe" }).success).toBe(false);
    expect(AppRefSchema.safeParse({ image: "dir/game" }).success).toBe(false);
    expect(AppRefSchema.safeParse({ bundleId: "com.x.y", image: "a.exe" }).success).toBe(false);
    expect(AppRefSchema.safeParse({ bundleId: "nodots" }).success).toBe(false);
    expect(AppRefSchema.safeParse({ signer: "x".repeat(129) }).success).toBe(false);
    expect(AppRefSchema.safeParse({ image: "" }).success).toBe(false);
  });

  it("limits each app list to 100", () => {
    const apps = (n: number) => Array.from({ length: n }, (_, i) => ({ image: `app${i}.exe` }));
    expect(MAX_POLICY_APP_REFS).toBe(100);
    expect(ok({ apps: { block: apps(100), approved: apps(100), requireApproval: true } })).toBe(true);
    expect(ok({ apps: { block: apps(101) } })).toBe(false);
    expect(ok({ apps: { approved: apps(101) } })).toBe(false);
    expect(ok({ screenTime: { allowDuringDowntime: apps(101) } })).toBe(false);
  });
});

describe("PolicyRulesSchema: screenTime", () => {
  it("accepts per-day minutes (0 to 1440) or null, downtime across midnight, and warnMinutes", () => {
    expect(st({ dailyMinutes: { mon: 0, tue: 60, wed: 1440, thu: null, fri: 90, sat: 180, sun: null }, downtime: [{ start: "21:00", end: "07:00" }, { start: "13:00", end: "14:30" }], warnMinutes: 10 })).toBe(true);
    expect(st({ dailyMinutes: { mon: 30 } })).toBe(true);
  });

  it("rejects minutes out of range, fractions, strings and unknown weekdays being treated as data", () => {
    expect(st({ dailyMinutes: { mon: -1 } })).toBe(false);
    expect(st({ dailyMinutes: { mon: 1441 } })).toBe(false);
    expect(st({ dailyMinutes: { mon: 1.5 } })).toBe(false);
    expect(st({ dailyMinutes: { mon: "60" } })).toBe(false);
    expect(PolicyRulesSchema.parse({ screenTime: { dailyMinutes: { mon: 5, funday: 9 } } }).screenTime?.dailyMinutes).toEqual({ mon: 5 });
  });

  it("rejects bad times", () => {
    for (const bad of ["24:00", "7:00", "07:60", "0700", "07:00:00", "", "ab:cd", "-1:00"]) {
      expect(st({ downtime: [{ start: bad, end: "07:00" }] }), bad).toBe(false);
      expect(st({ downtime: [{ start: "21:00", end: bad }] }), bad).toBe(false);
    }
    expect(st({ downtime: [{ start: "00:00", end: "23:59" }] })).toBe(true);
    expect(st({ downtime: [{ start: "21:00" }] })).toBe(false);
  });

  it("limits downtime to 6 windows and warnMinutes to 0-120", () => {
    const win = { start: "21:00", end: "07:00" };
    expect(MAX_DOWNTIME_WINDOWS).toBe(6);
    expect(st({ downtime: Array.from({ length: 6 }, () => win) })).toBe(true);
    expect(st({ downtime: Array.from({ length: 7 }, () => win) })).toBe(false);
    expect(st({ warnMinutes: 120 })).toBe(true);
    expect(st({ warnMinutes: 121 })).toBe(false);
    expect(st({ warnMinutes: -1 })).toBe(false);
  });
});

describe("PolicyRulesSchema: notify.childRequestsTo and compatibility", () => {
  it("takes owners or helpers", () => {
    expect(ok({ notify: { childRequestsTo: "owners" } })).toBe(true);
    expect(ok({ notify: { childRequestsTo: "helpers" } })).toBe(true);
    expect(ok({ notify: { childRequestsTo: "everyone" } })).toBe(false);
  });

  it("still parses every policy shape written before Child mode", () => {
    const stored = [
      {},
      { notify: { helpersNotifyAt: "high", ownersNotifyAt: "low" } },
      { remote_access: { unknownPeerSeverity: "critical", sessionWindowMinutes: 30 }, payments: { underPressureWindowMinutes: 60 }, notify: { helpersNotifyAt: "high", ownersNotifyAt: "high" }, devices: { protectionDisabledSeverity: "high" } },
      { notify: { ownersNotifyAt: "medium" }, screen_time: { legacy: true }, junk: 1 }, // the old placeholder key is stripped
      { web: { legacy: true }, apps: { legacy: true } }, // the old unvalidated placeholders carried no known field
    ];
    for (const rules of stored) expect(PolicyRulesSchema.safeParse(rules).success, JSON.stringify(rules)).toBe(true);
    expect(PolicyRulesSchema.parse({ notify: { ownersNotifyAt: "low" }, screen_time: { x: 1 } })).toEqual({ notify: { ownersNotifyAt: "low" } });
  });

  it("applies no defaults, so a partial layer stays partial", () => {
    expect(PolicyRulesSchema.parse({ web: { block: ["a.com"] } })).toEqual({ web: { block: ["a.com"] } });
    expect(PolicyRulesSchema.parse({ screenTime: { dailyMinutes: { mon: 5 } } })).toEqual({ screenTime: { dailyMinutes: { mon: 5 } } });
  });
});

describe("Child signal events", () => {
  const ID = "11111111-1111-4111-8111-111111111111";
  const base = { id: ID, observedAt: "2026-11-02T12:00:00Z" };
  const webBlocked = { ...base, type: "page", detector: "web_blocked", domain: "bad.example.com", category: "self_harm" };
  const appInstalled = { ...base, type: "software", detector: "app_installed", name: "Roblox", signer: "Roblox Corporation", image: "RobloxPlayerBeta.exe" };
  const appBlocked = { ...base, type: "software", detector: "app_blocked", name: "Roblox", bundleId: "com.roblox.RobloxPlayer" };
  const exhausted = { ...base, type: "usage", detector: "screen_time_exhausted" };
  const tamper = { ...base, type: "tamper", detector: "tamper_detected", reason: "vpn_app" };

  it("are listed detectors and accept one valid example each", () => {
    for (const d of ["web_blocked", "app_installed", "app_blocked", "screen_time_exhausted", "tamper_detected"]) expect(SIGNAL_DETECTORS as readonly string[]).toContain(d);
    for (const event of [webBlocked, appInstalled, appBlocked, exhausted, tamper]) {
      const r = SignalEventSchema.safeParse(event);
      expect(r.success, `${event.detector}: ${JSON.stringify(r.success ? null : r.error.issues)}`).toBe(true);
    }
  });

  it("accept every tamper reason, including bad_policy_signature, and reject unknown ones", () => {
    expect(TAMPER_REASONS).toEqual(["browser_without_extension", "vpn_app", "extension_disabled", "clock_changed", "agent_service_stopped", "bad_policy_signature"]);
    for (const reason of TAMPER_REASONS) expect(SignalEventSchema.safeParse({ ...tamper, reason }).success, reason).toBe(true);
    for (const reason of ["rooted", "", "VPN_APP", undefined]) expect(SignalEventSchema.safeParse({ ...tamper, reason }).success, String(reason)).toBe(false);
  });

  it("reject URLs, paths, unknown categories and extra keys (minimized payloads)", () => {
    expect(SignalEventSchema.safeParse({ ...webBlocked, url: "https://bad.example.com/x?q=1" }).success).toBe(false);
    expect(SignalEventSchema.safeParse({ ...webBlocked, domain: "bad.example.com/x" }).success).toBe(false);
    expect(SignalEventSchema.safeParse({ ...webBlocked, domain: "BAD.example.com" }).success).toBe(false);
    expect(SignalEventSchema.safeParse({ ...webBlocked, category: "news" }).success).toBe(false);
    expect(SignalEventSchema.safeParse({ ...webBlocked, category: undefined }).success).toBe(false);
    expect(SignalEventSchema.safeParse({ ...appInstalled, path: "C:\\Games\\r.exe" }).success).toBe(false);
    expect(SignalEventSchema.safeParse({ ...appInstalled, image: "C:\\Games\\r.exe" }).success).toBe(false);
    expect(SignalEventSchema.safeParse({ ...appBlocked, bundleId: "nodots" }).success).toBe(false);
    expect(SignalEventSchema.safeParse({ ...exhausted, minutes: 60 }).success).toBe(false);
    expect(SignalEventSchema.safeParse({ ...appInstalled, name: "" }).success).toBe(false);
  });

  it("a malformed one is rejected with its id kept for the per-event result", () => {
    expect(parseSignalEvent({ ...tamper, reason: "nope" })).toEqual({ ok: false, id: ID, reason: "invalid" });
  });
});
