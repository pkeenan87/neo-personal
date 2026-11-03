import { PolicyBundleSchema, canonicalJson } from "@neo/verdict";
import { describe, expect, it } from "vitest";
import { compileBundle, endOfLocalDay, type CompileBundleInput } from "../src/index.js";

const NOW = new Date("2026-11-02T15:00:00.000Z");
const ids = { device: { id: "11111111-1111-4111-8111-111111111111" }, member: { id: "22222222-2222-4222-8222-222222222222" } };
const child = (over: Partial<CompileBundleInput> = {}): CompileBundleInput => ({ ...ids, layers: { mode: "child" }, birthYear: 2015, timeZone: "UTC", now: NOW, grants: [], ...over });

describe("endOfLocalDay", () => {
  it("is the next local midnight in the household zone, and UTC midnight without one", () => {
    expect(endOfLocalDay(NOW, null).toISOString()).toBe("2026-11-03T00:00:00.000Z");
    expect(endOfLocalDay(NOW, "UTC").toISOString()).toBe("2026-11-03T00:00:00.000Z");
    // 15:00Z is 10:00 in New York (EST, UTC-5): the day ends at 05:00Z the next day.
    expect(endOfLocalDay(NOW, "America/New_York").toISOString()).toBe("2026-11-03T05:00:00.000Z");
    // 15:00Z is already 01:00 the next day in Auckland (NZDT, UTC+13): today ends at 11:00Z on the 3rd.
    expect(endOfLocalDay(NOW, "Pacific/Auckland").toISOString()).toBe("2026-11-03T11:00:00.000Z");
  });

  it("survives a daylight-saving change on the day (23 and 25 hour days)", () => {
    // US spring forward 2026-03-08: New York midnight to midnight is 23 hours.
    const spring = endOfLocalDay(new Date("2026-03-08T12:00:00.000Z"), "America/New_York");
    expect(spring.toISOString()).toBe("2026-03-09T04:00:00.000Z"); // EDT (UTC-4) after the change
    // US fall back 2026-11-01: a 25-hour day.
    const fall = endOfLocalDay(new Date("2026-11-01T12:00:00.000Z"), "America/New_York");
    expect(fall.toISOString()).toBe("2026-11-02T05:00:00.000Z"); // EST (UTC-5)
  });

  it("falls back to UTC for a name Intl does not know", () => {
    expect(endOfLocalDay(NOW, "Not/AZone").toISOString()).toBe("2026-11-03T00:00:00.000Z");
  });
});

describe("compileBundle grants and allowOnce", () => {
  it("leaves a bundle without grants byte-identical to before (allowOnce is absent, not empty)", () => {
    const b = compileBundle(child());
    expect(b.web).not.toHaveProperty("allowOnce");
    expect(canonicalJson(b.web)).not.toContain("allowOnce");
    expect(compileBundle(child({ allowOnce: [] })).policyVersion).toBe(b.policyVersion);
  });

  it("puts running grants in screenTime.grants and web.allowOnce, sorted, and changes the version", () => {
    const base = compileBundle(child());
    const grants = [
      { minutes: 45, until: "2026-11-03T00:00:00.000Z" },
      { minutes: 30, until: "2026-11-03T00:00:00.000Z" },
    ];
    const allowOnce = [
      { domain: "b.example", until: "2026-11-02T17:00:00.000Z" },
      { domain: "a.example", until: "2026-11-02T16:00:00.000Z" },
    ];
    const b = compileBundle(child({ grants, allowOnce }));
    expect(PolicyBundleSchema.safeParse(b).success).toBe(true);
    expect(b.screenTime.grants).toEqual([grants[1], grants[0]]);
    expect(b.web.allowOnce).toEqual([allowOnce[1], allowOnce[0]]);
    expect(b.policyVersion).not.toBe(base.policyVersion);
    // Order of the input does not matter.
    expect(compileBundle(child({ grants: [...grants].reverse(), allowOnce: [...allowOnce].reverse() })).policyVersion).toBe(b.policyVersion);
    // A grant that has run out is simply not passed in, and the version returns to the plain one.
    expect(compileBundle(child({ grants: [], allowOnce: [] })).policyVersion).toBe(base.policyVersion);
  });

  it("ignores grants for a Standard or Elder device", () => {
    const g = { grants: [{ minutes: 30, until: "2026-11-03T00:00:00.000Z" }], allowOnce: [{ domain: "a.example", until: "2026-11-02T16:00:00.000Z" }] };
    const std = compileBundle({ ...child(g), layers: { mode: "standard" } });
    expect(std.screenTime.grants).toEqual([]);
    expect(std.web).not.toHaveProperty("allowOnce");
  });
});
