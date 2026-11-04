/**
 * Read-only comparison of the two runners' `schedule_runs` rows (_specs/v2-m3-cutover.md section 1).
 *
 * Advisory: an eve shadow run and an Inngest live run of the same cycle read the same data a moment apart,
 * and the live one changes it (marks a device, drains a row), so a differing digest on a state-changing job
 * can be that race rather than a bug. Look at the pairs that differ in more than one cycle.
 */
import { listScheduleRuns, type ScheduleRunRow } from "@neo/db";
import { getDb } from "@/lib/server/db";
import { SCHEDULE_CADENCE_MS, type ScheduleJob } from "./config";

export interface RunView {
  id: string;
  runner: "inngest" | "eve";
  mode: "shadow" | "live";
  startedAt: Date;
  outcome: "ok" | "error";
  digest: string | null;
  actions: number;
  counts: Record<string, number>;
  error: string | null;
}

export interface RunPair {
  inngest: RunView;
  eve: RunView;
  /** Both runs finished ok and planned the same actions. */
  digestsMatch: boolean;
}

export interface ScheduleComparison {
  job: string;
  since: Date;
  pairs: RunPair[];
  /** Runs with no counterpart in their cycle (for example, the eve run while it is live and Inngest skips). */
  unpaired: RunView[];
}

/** Runs of the two runners are paired when they started within half a cycle of each other, at most 10 minutes. */
const MAX_PAIR_GAP_MS = 10 * 60_000;

export function toRunView(row: ScheduleRunRow): RunView {
  return {
    id: row.id,
    runner: row.runner,
    mode: row.mode,
    startedAt: row.startedAt,
    outcome: row.outcome,
    digest: row.summary?.digest ?? null,
    actions: row.summary?.actions ?? 0,
    counts: row.summary?.counts ?? {},
    error: row.error,
  };
}

/** Pair each eve run with the nearest unused Inngest run of the same job. Pure. */
export function pairScheduleRuns(job: string, rows: readonly ScheduleRunRow[]): Pick<ScheduleComparison, "pairs" | "unpaired"> {
  const cadence = (SCHEDULE_CADENCE_MS as Record<string, number | undefined>)[job] ?? MAX_PAIR_GAP_MS * 2;
  const maxGap = Math.min(cadence / 2, MAX_PAIR_GAP_MS);
  const views = rows.filter((r) => r.job === job).map(toRunView).sort((a, b) => +a.startedAt - +b.startedAt);
  const inngest = views.filter((v) => v.runner === "inngest");
  const used = new Set<string>();
  const pairs: RunPair[] = [];
  const unpaired: RunView[] = [];
  for (const eve of views.filter((v) => v.runner === "eve")) {
    let best: RunView | undefined;
    for (const candidate of inngest) {
      if (used.has(candidate.id)) continue;
      const gap = Math.abs(+candidate.startedAt - +eve.startedAt);
      if (gap <= maxGap && (!best || gap < Math.abs(+best.startedAt - +eve.startedAt))) best = candidate;
    }
    if (!best) {
      unpaired.push(eve);
      continue;
    }
    used.add(best.id);
    pairs.push({ inngest: best, eve, digestsMatch: best.outcome === "ok" && eve.outcome === "ok" && best.digest === eve.digest });
  }
  for (const v of inngest) if (!used.has(v.id)) unpaired.push(v);
  return { pairs, unpaired: unpaired.sort((a, b) => +a.startedAt - +b.startedAt) };
}

/** The runs of `job` since `since`, paired by cycle. Read-only; empty without a database. */
export async function compareScheduleRuns(job: ScheduleJob | string, since: Date): Promise<ScheduleComparison> {
  const db = getDb();
  const rows = db ? await listScheduleRuns(db, job, since) : [];
  return { job, since, ...pairScheduleRuns(job, rows) };
}
