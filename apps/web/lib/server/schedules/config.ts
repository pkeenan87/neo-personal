/**
 * Which runner owns each background job (_specs/v2-m3-cutover.md section 1).
 *
 * `NEO_EVE_SCHEDULES` is a comma-separated list of job names. A listed job runs live in its eve schedule
 * and is a no-op in Inngest; every other job runs live in Inngest and in shadow in eve. Unset (the default)
 * leaves production exactly as it was: Inngest live, eve shadow (read-only).
 */
import { logger } from "@neo/core";
import type { EnvSource } from "@/lib/env";

export const SCHEDULE_JOBS = ["weekly-digest", "devices-offline", "breach-monitoring", "retention", "outbox-sweep"] as const;
export type ScheduleJob = (typeof SCHEDULE_JOBS)[number];
export type ScheduleRunnerName = "inngest" | "eve";
export type RunMode = "shadow" | "live";

/** Standard 5-field UTC crons, the same cadence as the Inngest functions (they add a `TZ=UTC ` prefix for the digest). */
export const SCHEDULE_CRONS: Record<ScheduleJob, string> = {
  "weekly-digest": "0 14 * * 1",
  "devices-offline": "0 * * * *",
  "breach-monitoring": "0 15 * * 1",
  retention: "0 4 * * *",
  "outbox-sweep": "*/5 * * * *",
};

/** How often each job fires, for pairing an Inngest run with the eve run of the same cycle. */
export const SCHEDULE_CADENCE_MS: Record<ScheduleJob, number> = {
  "weekly-digest": 7 * 24 * 60 * 60_000,
  "devices-offline": 60 * 60_000,
  "breach-monitoring": 7 * 24 * 60 * 60_000,
  retention: 24 * 60 * 60_000,
  "outbox-sweep": 5 * 60_000,
};

export function isScheduleJob(name: string): name is ScheduleJob {
  return (SCHEDULE_JOBS as readonly string[]).includes(name);
}

const warned = new Set<string>();

/** Parse the flag. Names are trimmed and matched exactly; an unknown name is ignored and warned about once per process. */
export function parseEveSchedules(raw: string | undefined, warn: (name: string) => void = warnUnknownOnce): ScheduleJob[] {
  const jobs = new Set<ScheduleJob>();
  for (const part of (raw ?? "").split(",")) {
    const name = part.trim();
    if (!name) continue;
    if (isScheduleJob(name)) jobs.add(name);
    else warn(name);
  }
  return [...jobs];
}

function warnUnknownOnce(name: string): void {
  if (warned.has(name)) return;
  warned.add(name);
  logger.warn(`NEO_EVE_SCHEDULES names a job that does not exist; ignored: ${JSON.stringify(name.slice(0, 64))}`, "schedules");
}

/** For tests: forget which unknown names were already warned about. */
export function resetScheduleWarnings(): void {
  warned.clear();
}

/**
 * What a runner does with a job right now. Eve always runs (shadow unless the job is listed); Inngest
 * runs live unless the job is listed, in which case it skips.
 */
export function scheduleRoute(job: ScheduleJob, runner: "eve", source?: EnvSource): RunMode;
export function scheduleRoute(job: ScheduleJob, runner: "inngest", source?: EnvSource): "live" | "skip";
export function scheduleRoute(job: ScheduleJob, runner: ScheduleRunnerName, source?: EnvSource): RunMode | "skip";
export function scheduleRoute(job: ScheduleJob, runner: ScheduleRunnerName, source: EnvSource = process.env): RunMode | "skip" {
  const eveOwns = parseEveSchedules(source.NEO_EVE_SCHEDULES).includes(job);
  if (runner === "eve") return eveOwns ? "live" : "shadow";
  return eveOwns ? "skip" : "live";
}
