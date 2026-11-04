/**
 * The shape every background job shares during the Inngest to eve cutover (_specs/v2-m3-cutover.md section 1).
 *
 * A job core plans first (reads only, recording what it would do), then, in live mode only, executes.
 * The write side is a separate `Effects` object that exists only in the `live` variant of `JobDeps`: a
 * shadow run has no way to reach a mailer, an alert insert or a delete, by type and by construction.
 */
import { createHash } from "node:crypto";
import { logger } from "@neo/core";
import { insertScheduleRun, type ScheduleRunInput } from "@neo/db";
import { getDb } from "@/lib/server/db";
import type { RunMode, ScheduleJob, ScheduleRunnerName } from "./config";

/** One thing a run would do. `key` is an id or a stable label: never an address, a name or message content. */
export type PlannedAction = { tenantId: string | null; kind: string; key: string };
export type Counts = Record<string, number>;

export type JobDeps<Read, Effects> = { mode: "shadow"; read: Read } | { mode: "live"; read: Read; effects: Effects };

export interface StepRunner {
  run<T>(name: string, fn: () => Promise<T>): Promise<T>;
}
/** Runs each step once, in order (the eve schedule: no memoization, no retries). */
export const inlineSteps: StepRunner = { run: (_name, fn) => fn() };

export interface ActionRecorder {
  record(action: PlannedAction): void;
  readonly actions: readonly PlannedAction[];
}

export function createRecorder(): ActionRecorder {
  const actions: PlannedAction[] = [];
  return { record: (action) => void actions.push({ tenantId: action.tenantId, kind: action.kind, key: action.key }), actions };
}

/** SHA-256 hex of the sorted `tenantId|kind|key` lines: equal plans give equal digests, whichever runner made them. */
export function plannedActionsDigest(actions: readonly PlannedAction[]): string {
  const lines = actions.map((a) => `${a.tenantId ?? "-"}|${a.kind}|${a.key}`).sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

export interface JobReport {
  job: ScheduleJob;
  runner: ScheduleRunnerName;
  mode: RunMode;
  counts: Counts;
  digest: string;
  actions: number;
}

export type RecordRun = (input: ScheduleRunInput) => Promise<void>;

/**
 * Insert one `schedule_runs` row. Never throws: a missing database (MOCK_MODE) or table (before the
 * migration) must not fail a job.
 */
export const recordScheduleRun: RecordRun = async (input) => {
  // The logger allow-lists metadata keys, so the run goes in the message (a digest is a hash; the rest are enums and counts).
  logger.info(`Schedule run ${input.job} ${input.runner} ${input.mode} ${input.outcome} actions=${input.summary.actions} digest=${input.summary.digest}`, "schedules");
  const db = getDb();
  if (!db) return;
  try {
    await insertScheduleRun(db, input);
  } catch (err) {
    logger.warn(`Schedule run could not be recorded (${input.job})`, "schedules", { errorMessage: errText(err) });
  }
};

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

function countsOf(actions: readonly PlannedAction[], extra: Counts): Counts {
  const counts: Counts = {};
  for (const a of actions) counts[`planned.${a.kind}`] = (counts[`planned.${a.kind}`] ?? 0) + 1;
  return { ...counts, ...extra };
}

/** What an Inngest function returns while NEO_EVE_SCHEDULES lists its job: nothing ran, and no run is recorded. */
export function skippedForEve(job: ScheduleJob): { skipped: "eve-schedule"; job: ScheduleJob } {
  logger.info(`Inngest job ${job} skipped: its eve schedule is live`, "schedules");
  return { skipped: "eve-schedule", job };
}

export interface JobMeta {
  job: ScheduleJob;
  runner: ScheduleRunnerName;
  mode: RunMode;
  startedAt: Date;
}

function toRow(meta: JobMeta, rec: ActionRecorder, extra: Counts, error?: unknown): ScheduleRunInput {
  return {
    job: meta.job,
    runner: meta.runner,
    mode: meta.mode,
    startedAt: meta.startedAt,
    finishedAt: new Date(),
    outcome: error === undefined ? "ok" : "error",
    summary: { counts: countsOf(rec.actions, extra), digest: plannedActionsDigest(rec.actions), actions: rec.actions.length },
    error: error === undefined ? null : errText(error),
  };
}

export interface RunJobOptions {
  meta: JobMeta;
  steps: StepRunner;
  /** Overrides `recordScheduleRun` (tests). */
  record?: RecordRun;
  /**
   * Inngest's multi-step jobs record in a final memoized step (code between steps reruns on every
   * replay; a step body runs once) and cannot catch around steps, so an error leaves no row there.
   */
  recordInStep?: boolean;
}

/**
 * Run a job core and record the run. Returns the report. An error in the core is recorded (unless
 * `recordInStep`) and rethrown, so the runner's own history still shows the failure.
 */
export async function runJob(options: RunJobOptions, core: (rec: ActionRecorder, steps: StepRunner) => Promise<Counts>): Promise<JobReport> {
  const { meta, steps } = options;
  const record = options.record ?? recordScheduleRun;
  const rec = createRecorder();
  let extra: Counts;
  try {
    extra = await core(rec, steps);
  } catch (err) {
    if (!options.recordInStep) await record(toRow(meta, rec, {}, err));
    throw err;
  }
  const row = toRow(meta, rec, extra);
  if (options.recordInStep) await steps.run("record-run", async () => record(row));
  else await record(row);
  return { job: meta.job, runner: meta.runner, mode: meta.mode, counts: row.summary.counts, digest: row.summary.digest, actions: row.summary.actions };
}
