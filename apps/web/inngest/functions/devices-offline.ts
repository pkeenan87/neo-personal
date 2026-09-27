/**
 * `devices-offline` (cron `0 * * * *`, hourly): raise `device_offline` for devices silent
 * for 48 hours (_specs/device-enrollment.md). The logic is runOfflineDeviceSweep().
 */
import { runOfflineDeviceSweep } from "@/lib/server/device-enrollment";
import { inngest } from "../client";

export const devicesOffline = inngest.createFunction(
  { id: "devices-offline", name: "Alert on offline devices", triggers: [{ cron: "0 * * * *" }], retries: 2 },
  async ({ step }) => step.run("sweep", () => runOfflineDeviceSweep()),
);
