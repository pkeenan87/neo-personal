/**
 * `devices-offline` (cron `0 * * * *`, hourly): raise `device_offline` for devices silent
 * for 48 hours (_specs/device-enrollment.md). The logic is lib/server/schedules/jobs/devices-offline.ts, shared
 * with the eve schedule of the same name: this function is a no-op while NEO_EVE_SCHEDULES lists the job.
 */
import { inlineSteps, skippedForEve } from "@/lib/server/schedules/core";
import { SCHEDULE_CRONS, scheduleRoute } from "@/lib/server/schedules/config";
import { offlineDeps, runDevicesOffline } from "@/lib/server/schedules/jobs/devices-offline";
import { inngest } from "../client";

export const devicesOffline = inngest.createFunction(
  { id: "devices-offline", name: "Alert on offline devices", triggers: [{ cron: SCHEDULE_CRONS["devices-offline"] }], retries: 2 },
  async ({ step }) => {
    if (scheduleRoute("devices-offline", "inngest") === "skip") return skippedForEve("devices-offline");
    return step.run("sweep", () => runDevicesOffline({ runner: "inngest", deps: offlineDeps("live"), steps: inlineSteps }));
  },
);
