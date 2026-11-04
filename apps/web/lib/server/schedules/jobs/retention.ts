/**
 * `retention` (daily 04:00 UTC; the Inngest `artifacts-expire` function): purge expired artifacts and the
 * other retention sweeps (rejected inbound rows, old alerts and devices, signals, reputation cache,
 * digest payloads, expired child requests, the job log, expired household memory).
 *
 * Plan = the expired artifacts (listed read-only) plus one action per SQL purge. Those purges are
 * security-definer functions that delete and return a count, so a shadow run cannot preview their rows;
 * it records that the purge would run, plus read-only counts of what the household-data purges (signals, alerts,
 * child requests, memory) would delete under each household's retention settings (`previewPurges`). Live hands the planned artifacts to runArtifactsExpire.
 */
import { ARTIFACT_BATCH, runArtifactsExpire, type ExpireDeps } from "@/lib/server/inbound/artifacts-expire-job";
import { createExpireDeps, createExpireReadPorts } from "@/lib/server/inbound/deps";
import { runJob, type Counts, type JobDeps, type JobReport, type RecordRun, type StepRunner } from "../core";
import type { RunMode, ScheduleRunnerName } from "../config";

export type RetentionRead = ReturnType<typeof createExpireReadPorts>;
export type RetentionEffects = Omit<ExpireDeps, "artifacts"> & { purgeArtifact?: (id: string, tenantId?: string) => Promise<void> };
export type RetentionDeps = JobDeps<RetentionRead, RetentionEffects>;

/** The SQL purges runArtifactsExpire runs after the artifacts, in order. */
export const RETENTION_PURGES = [
  "inbound_rows",
  "alerts",
  "devices",
  "signals",
  "reputation_cache",
  "digest_payloads",
  "child_requests",
  "schedule_runs",
  "household_memory",
] as const;

export function retentionDeps(mode: RunMode): RetentionDeps {
  const read = createExpireReadPorts();
  if (mode === "shadow") return { mode, read };
  const { artifacts, ...rest } = createExpireDeps();
  return { mode, read, effects: { ...rest, ...(artifacts ? { purgeArtifact: (id, tenantId) => artifacts.purge(id, tenantId) } : {}) } };
}

export async function runRetention(options: {
  runner: ScheduleRunnerName;
  deps: RetentionDeps;
  steps: StepRunner;
  startedAt?: Date;
  record?: RecordRun;
  /** Inngest records in a final step (see RunJobOptions). */
  recordInStep?: boolean;
}): Promise<JobReport> {
  const { deps, steps } = options;
  const meta = { job: "retention" as const, runner: options.runner, mode: deps.mode, startedAt: options.startedAt ?? new Date() };
  return runJob({ meta, steps, record: options.record, recordInStep: options.recordInStep }, async (rec): Promise<Counts> => {
    const planned = await steps.run("retention-plan", () => deps.read.listExpiredArtifacts(ARTIFACT_BATCH));
    // What the household-data purges would delete now, per kind, by each household's settings (read-only). Both runners plan it, so plans stay comparable.
    const preview = await steps.run("retention-preview", async () => (await deps.read.previewPurges?.()) ?? null);
    for (const a of planned) rec.record({ tenantId: a.tenantId, kind: "artifact.purge", key: a.id });
    for (const name of RETENTION_PURGES) rec.record({ tenantId: null, kind: "retention.purge", key: name });
    if (preview) for (const kind of Object.keys(preview).sort()) rec.record({ tenantId: null, kind: "retention.would_purge", key: kind });
    if (deps.mode === "shadow") {
      return {
        artifactsExpired: planned.length,
        ...(preview ? { wouldPurgeSignals: preview.signals, wouldPurgeAlerts: preview.alerts, wouldPurgeChildRequests: preview.childRequests, wouldPurgeHouseholdMemory: preview.householdMemory } : {}),
      };
    }

    const { purgeArtifact, ...effects } = deps.effects;
    const result = await runArtifactsExpire(
      { ...effects, artifacts: purgeArtifact ? { listExpired: async () => planned, purge: purgeArtifact } : null },
      steps,
    );
    return { ...result };
  });
}
