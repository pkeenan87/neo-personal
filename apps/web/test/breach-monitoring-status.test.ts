import { describe, expect, it } from "vitest";
import { BREACH_STATUS_STALE_AFTER_MS, deriveAddressBreachStatus, deriveOverallBreachStatus } from "@/lib/server/breach-monitoring/status";

const NOW = new Date("2026-10-05T12:00:00.000Z");
const checked = (status: "never_checked" | "clean" | "breached" | "failed", daysAgo?: number) => ({
  verificationStatus: "verified" as const,
  checkStatus: status,
  lastSuccessfulCheckAt: daysAgo === undefined ? undefined : new Date(+NOW - daysAgo * 86_400_000),
});

describe("breach status freshness", () => {
  it("reports pending, never-checked, failed, breached and clean distinctly", () => {
    expect(deriveAddressBreachStatus({ ...checked("never_checked"), verificationStatus: "pending" }, NOW)).toBe("pending");
    expect(deriveAddressBreachStatus(checked("never_checked"), NOW)).toBe("never-checked");
    expect(deriveAddressBreachStatus(checked("failed", 1), NOW)).toBe("failed");
    expect(deriveAddressBreachStatus(checked("breached", 1), NOW)).toBe("breached");
    expect(deriveAddressBreachStatus(checked("clean", 1), NOW)).toBe("clean");
  });

  it("gives one grace day after the weekly cadence, then reports stale", () => {
    expect(BREACH_STATUS_STALE_AFTER_MS).toBe(8 * 86_400_000);
    expect(deriveAddressBreachStatus(checked("clean", 8), NOW)).toBe("clean");
    expect(deriveAddressBreachStatus(checked("clean", 9), NOW)).toBe("stale");
  });

  it("summarizes mixed addresses without claiming clean when one is unverified or failed", () => {
    expect(deriveOverallBreachStatus([checked("clean", 1), checked("breached", 2)], NOW)).toBe("breached");
    expect(deriveOverallBreachStatus([checked("clean", 1), checked("failed", 1)], NOW)).toBe("failed");
    expect(deriveOverallBreachStatus([checked("clean", 9), checked("clean", 1)], NOW)).toBe("stale");
    expect(deriveOverallBreachStatus([checked("clean", 1), { ...checked("never_checked"), verificationStatus: "pending" }], NOW)).toBe("never-checked");
  });
});
