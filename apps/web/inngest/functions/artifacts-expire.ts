/**
 * `artifacts-expire`: daily retention (cron 0 4 * * *, UTC). The logic is
 * lib/server/schedules/jobs/retention.ts, shared with the eve `retention` schedule: this function is a
 * no-op while NEO_EVE_SCHEDULES lists `retention`.
 */
import { skippedForEve, type StepRunner } from "@/lib/server/schedules/core";
import { SCHEDULE_CRONS, scheduleRoute } from "@/lib/server/schedules/config";
import { retentionDeps, runRetention } from "@/lib/server/schedules/jobs/retention";
import { inngest } from "../client";

export const artifactsExpire = inngest.createFunction(
  { id: "artifacts-expire", name: "Purge expired artifacts", triggers: [{ cron: SCHEDULE_CRONS.retention }], retries: 2 },
  async ({ step, event }) => {
    if (scheduleRoute("retention", "inngest") === "skip") return skippedForEve("retention");
    const steps: StepRunner = {
      run: <T>(name: string, fn: () => Promise<T>) => step.run(name, fn) as unknown as Promise<T>,
    };
    return runRetention({
      runner: "inngest",
      deps: retentionDeps("live"),
      steps,
      recordInStep: true,
      startedAt: new Date(event?.ts ?? Date.now()),
    });
  },
);
