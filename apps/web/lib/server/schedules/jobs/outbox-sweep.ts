/**
 * `outbox-sweep` (every 5 minutes): drain outbox rows that are due again, such as a crashed drain's
 * expired lease (_specs/v2-m1-elder.md section 6). Plan = the households with rows due; it never claims
 * or leases a row. Live drains them (drainPendingOutboxes). It also expires device commands (`end_session`) that
 * nobody answered within their 10 minutes, so a request never sits `pending` unseen (_specs/v2-m3-cutover.md section 4):
 * shadow counts them, live marks them expired and settles the incident's action.
 */
import { createOutboxDrainDeps, createOutboxReadPorts, drainPendingOutboxes, type DrainResult, type OutboxDrainDeps } from "@/lib/server/alerts/outbox";
import { expireStaleCommands, listExpiredCommands } from "@/lib/server/device-commands";
import { runJob, type Counts, type JobDeps, type JobReport, type RecordRun, type StepRunner } from "../core";
import type { RunMode, ScheduleRunnerName } from "../config";

export type OutboxRead = Pick<OutboxDrainDeps, "pendingTenants"> & { expiredCommands(now: Date): Promise<{ id: string; tenantId: string }[]> };
export type OutboxEffects = { drain(now: Date): Promise<DrainResult>; expireCommands(now: Date): Promise<number> };
export type OutboxSweepDeps = JobDeps<OutboxRead, OutboxEffects>;

export function outboxSweepDeps(mode: RunMode): OutboxSweepDeps {
  const read: OutboxRead = { ...createOutboxReadPorts(), expiredCommands: listExpiredCommands };
  if (mode === "shadow") return { mode, read };
  return { mode, read, effects: { drain: (now) => drainPendingOutboxes(createOutboxDrainDeps(), now), expireCommands: expireStaleCommands } };
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
    // Commands nobody answered in 10 minutes (end_session): the plan is their ids; live marks them expired and settles the incident.
    const expired = await deps.read.expiredCommands(now);
    for (const c of expired) rec.record({ tenantId: c.tenantId, kind: "command.expire", key: c.id });
    if (deps.mode === "shadow") return { tenants: tenants.length, expiredCommands: expired.length };
    const drained = await deps.effects.drain(now);
    return { ...drained, expiredCommands: await deps.effects.expireCommands(now) };
  });
}
