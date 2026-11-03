import { PolicyBundleSchema } from "@neo/verdict";
import { describe, expect, it } from "vitest";
import { compileBundle, computePolicyVersion, type CompileBundleInput } from "../src/index.js";

const NOW = new Date("2026-11-02T15:00:00.000Z");
const ids = { device: { id: "11111111-1111-4111-8111-111111111111" }, member: { id: "22222222-2222-4222-8222-222222222222" } };

function input(over: Partial<CompileBundleInput> & { layers?: CompileBundleInput["layers"] } = {}): CompileBundleInput {
  return { ...ids, layers: { mode: "standard" }, birthYear: null, timeZone: null, now: NOW, grants: [], ...over };
}

describe("compileBundle", () => {
  it("gives a Standard device the empty sections and a valid bundle", () => {
    const b = compileBundle(input());
    expect(PolicyBundleSchema.safeParse(b).success).toBe(true);
    expect(b).toMatchObject({
      v: 1,
      deviceId: ids.device.id,
      memberId: ids.member.id,
      mode: "standard",
      timeZone: "UTC",
      issuedAt: "2026-11-02T15:00:00.000Z",
      expiresAt: "2026-11-09T15:00:00.000Z",
      web: { categories: [], safeSearch: false, youtubeRestricted: "off", allow: [], block: [] },
      apps: { block: [], requireApproval: false, approved: [] },
      screenTime: { dailyMinutes: { mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null }, downtime: [], warnMinutes: 0, allowDuringDowntime: [], grants: [] },
    });
  });

  it("gives an Elder device the same empty sections, even if a stored layer carries web rules", () => {
    const b = compileBundle(input({ layers: { mode: "elder", member: { web: { categories: ["adult"] } } } }));
    expect(b.mode).toBe("elder");
    expect(b.web.categories).toEqual([]);
    expect(b.screenTime.grants).toEqual([]);
    expect(compileBundle(input({ layers: { mode: "standard" } })).policyVersion).not.toBe(b.policyVersion);
  });

  it("compiles each Child age band from the birth year and the household zone", () => {
    const small = compileBundle(input({ layers: { mode: "child" }, birthYear: 2019, timeZone: "America/New_York" }));
    expect(small.timeZone).toBe("America/New_York");
    expect(small.web.categories).toHaveLength(10);
    expect(small.web.youtubeRestricted).toBe("strict");
    expect(small.apps.requireApproval).toBe(true);
    expect(small.screenTime.dailyMinutes).toMatchObject({ mon: 60, sat: 120 });
    expect(small.screenTime.downtime).toEqual([{ start: "19:30", end: "07:00" }]);

    const mid = compileBundle(input({ layers: { mode: "child" }, birthYear: 2015 }));
    expect(mid.web.categories).toContain("dating");
    expect(mid.web.youtubeRestricted).toBe("moderate");
    expect(mid.screenTime.dailyMinutes).toMatchObject({ mon: 120, sun: 180 });

    const teen = compileBundle(input({ layers: { mode: "child" }, birthYear: 2011 }));
    expect(teen.apps.requireApproval).toBe(false);
    expect(teen.screenTime.dailyMinutes).toMatchObject({ mon: null, sat: null });
    expect(teen.screenTime.downtime).toEqual([{ start: "23:00", end: "06:00" }]);
    expect(PolicyBundleSchema.safeParse(teen).success).toBe(true);

    // Everything differs by band, so the versions do too.
    expect(new Set([small.policyVersion, mid.policyVersion, teen.policyVersion]).size).toBe(3);
  });

  it("applies the member layer over the age band, and carries grants for Child only", () => {
    const grants = [{ minutes: 30, until: "2026-11-02T23:00:00.000Z" }];
    const child = compileBundle(input({ layers: { mode: "child", member: { web: { block: ["games.example"] }, screenTime: { warnMinutes: 5 } } }, birthYear: 2015, grants }));
    expect(child.web.block).toEqual(["games.example"]);
    expect(child.screenTime.warnMinutes).toBe(5);
    expect(child.screenTime.grants).toEqual(grants);
    expect(compileBundle(input({ layers: { mode: "standard" }, grants })).screenTime.grants).toEqual([]);
  });
});

describe("policyVersion", () => {
  const child = (over: Partial<CompileBundleInput> = {}) => compileBundle(input({ layers: { mode: "child" }, birthYear: 2015, ...over }));

  it("is stable for equal inputs and 64 hex characters", () => {
    expect(child().policyVersion).toBe(child().policyVersion);
    expect(child().policyVersion).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not change with the time it was issued", () => {
    const later = child({ now: new Date("2026-11-05T09:30:00.000Z") });
    expect(later.issuedAt).not.toBe(child().issuedAt);
    expect(later.policyVersion).toBe(child().policyVersion);
  });

  it("matches the hash of the body without the timestamps", () => {
    const { issuedAt: _i, expiresAt: _e, policyVersion, ...body } = child();
    expect(computePolicyVersion(body)).toBe(policyVersion);
  });

  it("changes when a rule, a grant, the device, the zone or the band changes", () => {
    const base = child().policyVersion;
    expect(child({ layers: { mode: "child", member: { web: { block: ["x.example"] } } } }).policyVersion).not.toBe(base);
    expect(child({ layers: { mode: "child", member: { apps: { requireApproval: false } } } }).policyVersion).not.toBe(base);
    expect(child({ grants: [{ minutes: 15, until: "2026-11-02T23:00:00.000Z" }] }).policyVersion).not.toBe(base);
    expect(child({ device: { id: "33333333-3333-4333-8333-333333333333" } }).policyVersion).not.toBe(base);
    expect(child({ timeZone: "Europe/Paris" }).policyVersion).not.toBe(base);
    expect(child({ birthYear: 2008 }).policyVersion).not.toBe(base);
  });

  it("changes on the first of January in the household zone, when the age band moves", () => {
    const before = child({ birthYear: 2016, timeZone: "America/New_York", now: new Date("2026-01-01T03:00:00.000Z") }); // still 2025 in New York: age 9
    const after = child({ birthYear: 2016, timeZone: "America/New_York", now: new Date("2026-01-01T06:00:00.000Z") }); // 2026: age 10
    expect(before.web.youtubeRestricted).toBe("strict");
    expect(after.web.youtubeRestricted).toBe("moderate");
    expect(before.policyVersion).not.toBe(after.policyVersion);
  });
});
