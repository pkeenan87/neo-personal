/**
 * `outbox-sweep` (every 5 minutes): drain outbox rows that are due again, such as a crashed drain's
 * expired lease (_specs/v2-m1-elder.md section 6). Plan = the households with rows due; it never claims
 * or leases a row. Live drains them (drainPendingOutboxes).
 */
import { createOutboxDrainDeps, createOutboxReadPorts, drainPendingOutboxes, type DrainResult, type OutboxDrainDeps } from "@/lib/server/alerts/outbox";
import { runJob, type Counts, type JobDeps, type JobReport, type RecordRun, type StepRunner } from "../core";
import type { RunMode, ScheduleRunnerName } from "../config";

export type OutboxRead = Pick<OutboxDrainDeps, "pendingTenants">;
export type OutboxEffects = { drain(now: Date): Promise<DrainResult> };
export type OutboxSweepDeps = JobDeps<OutboxRead, OutboxEffects>;

export function outboxSweepDeps(mode: RunMode): OutboxSweepDeps {
  const read = createOutboxReadPorts();
  if (mode === "shadow") return { mode, read };
  return { mode, read, effects: { drain: (now) => drainPendingOutboxes(createOutboxDrainDeps(), now) } };
}

export async function runOutboxSweep(options: {
  runner: ScheduleRunnerName;
  deps: OutboxSweepDeps;
  steps: StepRunner;
  startedAt?: Date;
  now?: Date;
  record?: RecordRun;
}): Promise<JobReport> {
  const { deps } = options;
  const now = options.now ?? new Date();
  const meta = { job: "outbox-sweep" as const, runner: options.runner, mode: deps.mode, startedAt: options.startedAt ?? now };
  return runJob({ meta, steps: options.steps, record: options.record }, async (rec): Promise<Counts> => {
    const tenants = await deps.read.pendingTenants();
    for (const tenantId of tenants) rec.record({ tenantId, kind: "outbox.drain", key: "due" });
    if (deps.mode === "shadow") return { tenants: tenants.length };
    return { ...(await deps.effects.drain(now)) };
  });
}
