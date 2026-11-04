// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "@neo/core";
import type { ScheduleRunRow } from "@neo/db";
import { pairScheduleRuns } from "@/lib/server/schedules/compare";
import { parseEveSchedules, resetScheduleWarnings, SCHEDULE_JOBS, scheduleRoute } from "@/lib/server/schedules/config";
import { plannedActionsDigest, recordScheduleRun } from "@/lib/server/schedules/core";

afterEach(() => {
  vi.restoreAllMocks();
  resetScheduleWarnings();
});

describe("NEO_EVE_SCHEDULES switch", () => {
  it("unset: Inngest live, eve shadow, for every job (zero behaviour change)", () => {
    for (const job of SCHEDULE_JOBS) {
      expect(scheduleRoute(job, "inngest", {})).toBe("live");
      expect(scheduleRoute(job, "eve", {})).toBe("shadow");
      expect(scheduleRoute(job, "inngest", { NEO_EVE_SCHEDULES: "" })).toBe("live");
      expect(scheduleRoute(job, "eve", { NEO_EVE_SCHEDULES: "  ,, " })).toBe("shadow");
    }
  });

  it("listed: Inngest skips and eve runs live; the other jobs are unchanged", () => {
    const env = { NEO_EVE_SCHEDULES: "retention, outbox-sweep" };
    expect(scheduleRoute("retention", "inngest", env)).toBe("skip");
    expect(scheduleRoute("retention", "eve", env)).toBe("live");
    expect(scheduleRoute("outbox-sweep", "inngest", env)).toBe("skip");
    expect(scheduleRoute("outbox-sweep", "eve", env)).toBe("live");
    expect(scheduleRoute("weekly-digest", "inngest", env)).toBe("live");
    expect(scheduleRoute("weekly-digest", "eve", env)).toBe("shadow");
  });

  it("ignores unknown names with one warning each, and matches exactly", () => {
    const warn = vi.fn();
    expect(parseEveSchedules("retention,Retention,devices_offline,retention", warn)).toEqual(["retention"]);
    expect(warn.mock.calls.map((c) => c[0])).toEqual(["Retention", "devices_offline"]);
    // Through scheduleRoute (the process-wide warner), a repeated unknown name is warned about once.
    const spy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const env = { NEO_EVE_SCHEDULES: "nope" };
    scheduleRoute("retention", "eve", env);
    scheduleRoute("retention", "eve", env);
    expect(scheduleRoute("retention", "inngest", env)).toBe("live");
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("planned-action digest", () => {
  const a = { tenantId: "t1", kind: "x", key: "1" };
  const b = { tenantId: null, kind: "y", key: "2" };
  it("is order-independent and changes with any field", () => {
    expect(plannedActionsDigest([a, b])).toBe(plannedActionsDigest([b, a]));
    expect(plannedActionsDigest([a])).not.toBe(plannedActionsDigest([{ ...a, key: "2" }]));
    expect(plannedActionsDigest([a])).not.toBe(plannedActionsDigest([{ ...a, tenantId: "t2" }]));
    expect(plannedActionsDigest([])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("recordScheduleRun", () => {
  it("never throws without a database", async () => {
    await expect(
      recordScheduleRun({
        job: "retention", runner: "eve", mode: "shadow", startedAt: new Date(), finishedAt: new Date(), outcome: "ok",
        summary: { counts: {}, digest: "d", actions: 0 },
      }),
    ).resolves.toBeUndefined();
  });
});

describe("compare", () => {
  let n = 0;
  function run(runner: "inngest" | "eve", mode: "shadow" | "live", minute: number, digest: string, outcome: "ok" | "error" = "ok"): ScheduleRunRow {
    n += 1;
    return {
      id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, job: "outbox-sweep", runner, mode,
      startedAt: new Date(Date.UTC(2026, 10, 3, 10, minute)), finishedAt: new Date(Date.UTC(2026, 10, 3, 10, minute, 1)),
      outcome, summary: { counts: {}, digest, actions: 1 }, error: null,
    };
  }

  it("pairs each eve run with the nearest Inngest run of its cycle and flags digest differences", () => {
    const rows = [
      run("inngest", "live", 0, "aa"), run("eve", "shadow", 0, "aa"),
      run("inngest", "live", 5, "bb"), run("eve", "shadow", 5, "cc"),
      run("eve", "shadow", 10, "dd"), // Inngest missed this cycle
    ];
    const { pairs, unpaired } = pairScheduleRuns("outbox-sweep", rows);
    expect(pairs.map((p) => p.digestsMatch)).toEqual([true, false]);
    expect(unpaired.map((u) => u.runner)).toEqual(["eve"]);
  });

  it("does not call an errored run a match", () => {
    const { pairs } = pairScheduleRuns("outbox-sweep", [run("inngest", "live", 0, "aa"), run("eve", "shadow", 0, "aa", "error")]);
    expect(pairs[0]?.digestsMatch).toBe(false);
  });
});
