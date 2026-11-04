/**
 * `devices-offline` (hourly): raise `device_offline` for devices silent for 48 hours
 * (_specs/device-enrollment.md). Plan = the stale devices; live then marks, alerts and signals.
 */
import { DEVICE_OFFLINE_AFTER_MS } from "@neo/db";
import { applyOfflineSweep, createOfflineSweepDeps, type OfflineSweepDeps } from "@/lib/server/device-enrollment";
import { runJob, type Counts, type JobDeps, type JobReport, type RecordRun, type StepRunner } from "../core";
import type { RunMode, ScheduleRunnerName } from "../config";

export type OfflineRead = Pick<OfflineSweepDeps, "listStale">;
export type OfflineEffects = Omit<OfflineSweepDeps, "listStale">;
export type OfflineDeps = JobDeps<OfflineRead, OfflineEffects>;

/** Production wiring. The write side is only built for a live run. */
export function offlineDeps(mode: RunMode): OfflineDeps {
  const d = createOfflineSweepDeps();
  const read: OfflineRead = { listStale: d.listStale };
  if (mode === "shadow") return { mode, read };
  return { mode, read, effects: { markOffline: d.markOffline, alertOffline: d.alertOffline, protectionDisabled: d.protectionDisabled } };
}

export async function runDevicesOffline(options: {
  runner: ScheduleRunnerName;
  deps: OfflineDeps;
  steps: StepRunner;
  startedAt?: Date;
  now?: Date;
  record?: RecordRun;
}): Promise<JobReport> {
  const { deps } = options;
  const now = options.now ?? new Date();
  const meta = { job: "devices-offline" as const, runner: options.runner, mode: deps.mode, startedAt: options.startedAt ?? now };
  return runJob({ meta, steps: options.steps, record: options.record }, async (rec): Promise<Counts> => {
    const stale = await deps.read.listStale(new Date(now.getTime() - DEVICE_OFFLINE_AFTER_MS));
    for (const s of stale) rec.record({ tenantId: s.tenantId, kind: "device.offline", key: s.id });
    if (deps.mode === "shadow") return { stale: stale.length };
    return { ...(await applyOfflineSweep(stale, deps.effects, now)) };
  });
}
