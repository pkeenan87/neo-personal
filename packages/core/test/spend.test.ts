import { describe, expect, it } from "vitest";
import { estimateCostCents, isValidSpendCapCents, monthWindow, spendLevel } from "../src/spend.js";

const tokens = (o: Partial<Parameters<typeof estimateCostCents>[0]>) => ({
  model: "anthropic/claude-opus-5",
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  ...o,
});

describe("estimateCostCents", () => {
  it("prices tokens by the catalog model", () => {
    // Opus 5: $5 in / $25 out per million.
    expect(estimateCostCents(tokens({ inputTokens: 1_000_000, outputTokens: 100_000 }))).toBeCloseTo(750, 6);
    // The direct Anthropic id resolves to the same model.
    expect(estimateCostCents(tokens({ model: "claude-opus-5", inputTokens: 1_000_000 }))).toBeCloseTo(500, 6);
  });

  it("bills cache reads at 0.1x and cache writes at 1.25x of input", () => {
    expect(estimateCostCents(tokens({ cacheReadTokens: 1_000_000, cacheCreationTokens: 1_000_000 }))).toBeCloseTo(50 + 625, 6);
  });

  it("prices an unknown model at the dearest catalog rate rather than zero", () => {
    const unknown = estimateCostCents(tokens({ model: "mystery/model", outputTokens: 1_000_000 }));
    expect(unknown).toBeGreaterThanOrEqual(estimateCostCents(tokens({ outputTokens: 1_000_000 })));
  });
});

describe("monthWindow", () => {
  it("is the UTC calendar month for null and unknown zones", () => {
    const w = monthWindow(new Date("2026-12-31T23:59:59Z"), null);
    expect(w.start.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(w.end.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(w.month).toBe("2026-12");
    expect(monthWindow(new Date("2026-12-31T23:59:59Z"), "Not/AZone").month).toBe("2026-12");
  });

  it("follows the household time zone across the month boundary", () => {
    // Auckland (UTC+13 in November): 2026-11-30T12:00Z is already December there.
    const nz = monthWindow(new Date("2026-11-30T12:00:00Z"), "Pacific/Auckland");
    expect(nz.month).toBe("2026-12");
    expect(nz.start.toISOString()).toBe("2026-11-30T11:00:00.000Z");
    // Los Angeles (UTC-8): 2026-12-01T03:00Z is still November there.
    const la = monthWindow(new Date("2026-12-01T03:00:00Z"), "America/Los_Angeles");
    expect(la.month).toBe("2026-11");
    expect(la.end.toISOString()).toBe("2026-12-01T08:00:00.000Z");
  });

  it("handles a DST change inside the month", () => {
    const w = monthWindow(new Date("2026-03-15T12:00:00Z"), "America/New_York");
    expect(w.start.toISOString()).toBe("2026-03-01T05:00:00.000Z"); // EST
    expect(w.end.toISOString()).toBe("2026-04-01T04:00:00.000Z"); // EDT
  });
});

describe("spendLevel / isValidSpendCapCents", () => {
  it("is ok below 80%, warn from 80%, blocked from 100%, and always ok with no cap", () => {
    expect(spendLevel(790, 1000)).toBe("ok");
    expect(spendLevel(800, 1000)).toBe("warn");
    expect(spendLevel(999.9, 1000)).toBe("warn");
    expect(spendLevel(1000, 1000)).toBe("blocked");
    expect(spendLevel(1e9, null)).toBe("ok");
  });

  it("accepts whole cents from 100 to 1,000,000", () => {
    expect([100, 2500, 1_000_000].every(isValidSpendCapCents)).toBe(true);
    expect([99, 1_000_001, 12.5, "100", null, NaN].some(isValidSpendCapCents)).toBe(false);
  });
});
