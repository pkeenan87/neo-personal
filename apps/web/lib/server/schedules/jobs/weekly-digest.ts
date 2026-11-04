/**
 * `weekly-digest` (Mondays 14:00 UTC): the fan-out stage of the digest (_specs/weekly-digest.md). It freezes
 * the period and sends one `neo/digest.generate` event per recipient; the per-recipient delivery stays an
 * event-triggered Inngest function whatever runner fans out. Plan = the events (id `digest:<user>:<isoWeek>`);
 * live sends them. Shadow lists recipients only: it loads no content and renders and sends nothing.
 */
import { getDigestServices } from "@/lib/server/weekly-digest/services";
import { runWeeklyDigestCron } from "@/lib/server/weekly-digest/orchestration";
import type { DigestGenerateEvent } from "@/lib/server/weekly-digest/period";
import type { DigestRecipientStore } from "@/lib/server/weekly-digest/store";
import { inngest } from "@/inngest/client";
import { runJob, type Counts, type JobDeps, type JobReport, type RecordRun, type StepRunner } from "../core";
import type { RunMode, ScheduleRunnerName } from "../config";

export type DigestEvent = { id: string; name: string; data: DigestGenerateEvent };
export type DigestRead = DigestRecipientStore;
export type DigestEffects = { sendEvent(id: string, events: DigestEvent[]): Promise<unknown> };
export type WeeklyDigestDeps = JobDeps<DigestRead, DigestEffects>;

/** Production wiring for the eve schedule: events go through the Inngest client (the same ids dedupe against Inngest's own fan-out). */
export function weeklyDigestDeps(mode: RunMode): WeeklyDigestDeps {
  const read = getDigestServices().recipients;
  if (mode === "shadow") return { mode, read };
  return { mode, read, effects: { sendEvent: (_id, events) => inngest.send(events) } };
}

export async function runWeeklyDigest(options: {
  runner: ScheduleRunnerName;
  deps: WeeklyDigestDeps;
  steps: StepRunner;
  startedAt?: Date;
  now?: () => Date;
  record?: RecordRun;
  recordInStep?: boolean;
}): Promise<JobReport & Awaited<ReturnType<typeof runWeeklyDigestCron>>> {
  const { deps, steps } = options;
  const meta = { job: "weekly-digest" as const, runner: options.runner, mode: deps.mode, startedAt: options.startedAt ?? new Date() };
  let cron: Awaited<ReturnType<typeof runWeeklyDigestCron>> | undefined;
  const report = await runJob({ meta, steps, record: options.record, recordInStep: options.recordInStep }, async (rec): Promise<Counts> => {
    const effects = deps.mode === "live" ? deps.effects : undefined;
    cron = await runWeeklyDigestCron(
      {
        run: (id, fn) => steps.run(id, async () => fn()),
        sendEvent: async (id, events) => {
          for (const e of events) rec.record({ tenantId: e.data.tenantId, kind: "digest.send", key: e.id });
          return effects?.sendEvent(id, events);
        },
      },
      deps.read,
      options.now,
    );
    return { recipients: cron.recipients };
  });
  return { ...report, ...cron! };
}
