/**
 * `schedule_runs` (_specs/v2-m3-cutover.md section 1): one insert when a background job finishes, by
 * either runner. Tenant-less like `reputation_cache` (no RLS), so it is queried with the raw `db`
 * (see docs/rls.md). Rows hold counts and a digest of the planned actions, never household data.
 */
import { and, asc, eq, gte, lt } from "drizzle-orm";
import type { Db } from "./client.js";
import { scheduleRuns, type ScheduleRunMode, type ScheduleRunner, type ScheduleRunOutcome, type ScheduleRunSummary } from "./schema/index.js";

export type ScheduleRunRow = typeof scheduleRuns.$inferSelect;
export type ScheduleRunInput = {
  job: string;
  runner: ScheduleRunner;
  mode: ScheduleRunMode;
  startedAt: Date;
  finishedAt: Date;
  outcome: ScheduleRunOutcome;
  summary: ScheduleRunSummary;
  error?: string | null;
};

export const SCHEDULE_RUN_ERROR_MAX = 300;
/** `schedule_runs` rows older than this many days are pruned by the retention job. */
export const SCHEDULE_RUN_RETENTION_DAYS = 90;

export async function insertScheduleRun(db: Db, input: ScheduleRunInput): Promise<ScheduleRunRow> {
  const [row] = await db
    .insert(scheduleRuns)
    .values({ ...input, error: input.error ? input.error.slice(0, SCHEDULE_RUN_ERROR_MAX) : null })
    .returning();
  if (!row) throw new Error("schedule run insert failed");
  return row;
}

/** Runs of one job that started at or after `since`, oldest first. */
export async function listScheduleRuns(db: Db, job: string, since: Date, limit = 1000): Promise<ScheduleRunRow[]> {
  return db
    .select()
    .from(scheduleRuns)
    .where(and(eq(scheduleRuns.job, job), gte(scheduleRuns.startedAt, since)))
    .orderBy(asc(scheduleRuns.startedAt))
    .limit(limit);
}

/** Retention: runs that started more than `olderThanDays` days ago. Returns the count. */
export async function pruneScheduleRuns(db: Db, olderThanDays: number, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - olderThanDays * 24 * 60 * 60 * 1000);
  const rows = await db.delete(scheduleRuns).where(lt(scheduleRuns.startedAt, cutoff)).returning({ id: scheduleRuns.id });
  return rows.length;
}
