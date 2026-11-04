/**
 * `outbox-sweep` (cron every 5 minutes): drain outbox rows that are due again, such as a
 * crashed drain's expired lease (_specs/v2-m1-elder.md §6). The logic is lib/server/schedules/jobs/outbox-sweep.ts
 * (drainPendingOutboxes), shared with the eve schedule of the same name: this function is a no-op while
 * NEO_EVE_SCHEDULES lists the job.
 */
import { inlineSteps, skippedForEve } from "@/lib/server/schedules/core";
import { SCHEDULE_CRONS, scheduleRoute } from "@/lib/server/schedules/config";
import { outboxSweepDeps, runOutboxSweep } from "@/lib/server/schedules/jobs/outbox-sweep";
import { inngest } from "../client";

export const outboxSweep = inngest.createFunction(
  { id: "outbox-sweep", name: "Sweep the notification outbox", triggers: [{ cron: SCHEDULE_CRONS["outbox-sweep"] }], retries: 1, concurrency: 1 },
  async ({ step }) => {
    if (scheduleRoute("outbox-sweep", "inngest") === "skip") return skippedForEve("outbox-sweep");
    return step.run("sweep", () => runOutboxSweep({ runner: "inngest", deps: outboxSweepDeps("live"), steps: inlineSteps }));
  },
);
