/**
 * One row per run of a background job, by either runner (Inngest or an eve schedule), so the owner
 * can compare what the two would do during the M3 cutover (_specs/v2-m3-cutover.md section 1).
 *
 * Job-level, not household data: no tenant_id and no RLS (like `reputation_cache`). `summary` holds
 * counts and a digest of the planned actions only, never an address, an email or message content.
 */
import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const SCHEDULE_RUNNERS = ["inngest", "eve"] as const;
export type ScheduleRunner = (typeof SCHEDULE_RUNNERS)[number];
export const SCHEDULE_RUN_MODES = ["shadow", "live"] as const;
export type ScheduleRunMode = (typeof SCHEDULE_RUN_MODES)[number];
export const SCHEDULE_RUN_OUTCOMES = ["ok", "error"] as const;
export type ScheduleRunOutcome = (typeof SCHEDULE_RUN_OUTCOMES)[number];

export type ScheduleRunSummary = {
  /** Named counts (planned actions by kind, plus the job's own result counters). */
  counts: Record<string, number>;
  /** SHA-256 hex of the sorted planned actions. */
  digest: string;
  /** How many actions were planned. */
  actions: number;
};

export const scheduleRuns = pgTable(
  "schedule_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    job: text("job").notNull(),
    runner: text("runner").$type<ScheduleRunner>().notNull(),
    mode: text("mode").$type<ScheduleRunMode>().notNull(),
    startedAt: timestamp("started_at", { mode: "date", withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { mode: "date", withTimezone: true }).notNull(),
    outcome: text("outcome").$type<ScheduleRunOutcome>().notNull(),
    summary: jsonb("summary").$type<ScheduleRunSummary>().notNull().default(sql`'{}'::jsonb`),
    error: text("error"),
  },
  (t) => [
    index("schedule_runs_job_started_idx").on(t.job, t.startedAt.desc()),
    check("schedule_runs_runner_check", sql`${t.runner} in ('inngest', 'eve')`),
    check("schedule_runs_mode_check", sql`${t.mode} in ('shadow', 'live')`),
    check("schedule_runs_outcome_check", sql`${t.outcome} in ('ok', 'error')`),
    check("schedule_runs_error_length_check", sql`${t.error} is null or char_length(${t.error}) <= 300`),
  ],
);
