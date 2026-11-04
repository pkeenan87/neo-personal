/**
 * What an eve schedule runs when its cron fires (apps/web/agent/schedules/*). No model and no session: the
 * schedule's `run` handler calls this and never `to(...).send`. The mode comes from NEO_EVE_SCHEDULES
 * (config.ts): shadow unless the job is listed, in which case it is live and Inngest skips it.
 */
import { inlineSteps, type JobReport } from "./core";
import { scheduleRoute, type ScheduleJob } from "./config";
import { breachMonitoringDeps, runBreachMonitoring } from "./jobs/breach-monitoring";
import { offlineDeps, runDevicesOffline } from "./jobs/devices-offline";
import { outboxSweepDeps, runOutboxSweep } from "./jobs/outbox-sweep";
import { retentionDeps, runRetention } from "./jobs/retention";
import { runWeeklyDigest, weeklyDigestDeps } from "./jobs/weekly-digest";

export async function runEveSchedule(job: ScheduleJob, source: Record<string, string | undefined> = process.env): Promise<JobReport> {
  const mode = scheduleRoute(job, "eve", source);
  const base = { runner: "eve" as const, steps: inlineSteps };
  switch (job) {
    case "weekly-digest":
      return runWeeklyDigest({ ...base, deps: weeklyDigestDeps(mode) });
    case "devices-offline":
      return runDevicesOffline({ ...base, deps: offlineDeps(mode) });
    case "breach-monitoring":
      return runBreachMonitoring({ ...base, deps: breachMonitoringDeps(mode) });
    case "retention":
      return runRetention({ ...base, deps: retentionDeps(mode) });
    case "outbox-sweep":
      return runOutboxSweep({ ...base, deps: outboxSweepDeps(mode) });
  }
}
