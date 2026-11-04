// @vitest-environment node
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { artifactsExpire } from "@/inngest/functions/artifacts-expire";
import { devicesOffline } from "@/inngest/functions/devices-offline";
import { breachMonitoringCron } from "@/inngest/functions/breach-monitoring";
import { outboxSweep } from "@/inngest/functions/outbox-sweep";
import { weeklyDigestCron } from "@/inngest/functions/weekly-digest";
import { SCHEDULE_CRONS, SCHEDULE_JOBS, type ScheduleJob } from "@/lib/server/schedules/config";

const runEveSchedule = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/server/schedules/eve", () => ({ runEveSchedule }));

const dir = fileURLToPath(new URL("../agent/schedules", import.meta.url));

/** A 5-field cron: each field is *, a number, a range, a list or a step, within its bounds. */
function validCron(cron: string): boolean {
  const bounds = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const;
  const fields = cron.split(" ");
  if (fields.length !== 5) return false;
  return fields.every((field, i) =>
    field.split(",").every((part) => {
      const [range = "", step] = part.split("/");
      if (step !== undefined && !/^[1-9]\d*$/.test(step)) return false;
      if (range === "*") return true;
      const [lo, hi = lo] = range.split("-").map(Number);
      const [min, max] = bounds[i]!;
      return Number.isInteger(lo) && Number.isInteger(hi) && lo! >= min && hi! <= max && lo! <= hi!;
    }),
  );
}

describe("eve schedule definitions", () => {
  it("has one file per job, named for it", () => {
    expect(readdirSync(dir).map((f) => f.replace(/\.ts$/, "")).sort()).toEqual([...SCHEDULE_JOBS].sort());
  });

  it.each(SCHEDULE_JOBS)("%s: a valid UTC cron, a run handler, no prompt", async (job) => {
    const mod = (await import(`../agent/schedules/${job}.ts`)) as { default: { cron: string; content?: string; run?: () => Promise<void> } };
    const def = mod.default;
    expect(validCron(def.cron)).toBe(true);
    expect(def.cron).toBe(SCHEDULE_CRONS[job]);
    expect(def.content).toBeUndefined(); // a prompt would start a model session
    expect(typeof def.run).toBe("function");
    runEveSchedule.mockClear();
    await def.run!();
    expect(runEveSchedule).toHaveBeenCalledWith(job);
  });

  it("keeps the eve cron equal to the Inngest cron (minus the TZ=UTC prefix)", () => {
    const inngestCron = (fn: { opts: { triggers?: unknown } }): string => {
      const trigger = (fn.opts.triggers as Array<{ cron?: string }>).find((t) => t.cron)!;
      return trigger.cron!.replace(/^TZ=UTC /, "");
    };
    const expected: Record<ScheduleJob, string> = {
      "weekly-digest": inngestCron(weeklyDigestCron),
      "devices-offline": inngestCron(devicesOffline),
      "breach-monitoring": inngestCron(breachMonitoringCron),
      retention: inngestCron(artifactsExpire),
      "outbox-sweep": inngestCron(outboxSweep),
    };
    expect(SCHEDULE_CRONS).toEqual(expected);
  });

  it("makes each Inngest function a no-op while NEO_EVE_SCHEDULES lists its job, and live otherwise", async () => {
    type Handler = (ctx: { step: { run: ReturnType<typeof vi.fn>; sendEvent: ReturnType<typeof vi.fn> }; event?: { ts: number } }) => Promise<unknown>;
    const handlers = [weeklyDigestCron, devicesOffline, breachMonitoringCron, artifactsExpire, outboxSweep].map((f) => (f as unknown as { fn: Handler }).fn);

    vi.stubEnv("NEO_EVE_SCHEDULES", SCHEDULE_JOBS.join(","));
    for (const fn of handlers) {
      const step = { run: vi.fn(), sendEvent: vi.fn() };
      expect(await fn({ step })).toMatchObject({ skipped: "eve-schedule" });
      expect(step.run).not.toHaveBeenCalled();
      expect(step.sendEvent).not.toHaveBeenCalled();
    }

    // Unset: the Inngest function runs (it reaches its first step).
    vi.stubEnv("NEO_EVE_SCHEDULES", "");
    const step = { run: vi.fn(async () => ({ stale: 0 })), sendEvent: vi.fn() };
    await (devicesOffline as unknown as { fn: Handler }).fn({ step });
    expect(step.run).toHaveBeenCalledWith("sweep", expect.any(Function));
    vi.unstubAllEnvs();
  });
});
