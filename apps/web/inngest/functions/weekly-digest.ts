import { NonRetriableError } from "inngest";
import { inboundEnv } from "@/lib/env";
import { getMailer } from "@/lib/server/email/resend";
import { getDigestServices } from "@/lib/server/weekly-digest/services";
import { runWeeklyDigestDelivery, type DigestStepTools } from "@/lib/server/weekly-digest/orchestration";
import { digestGenerateEventSchema, DIGEST_GENERATE_EVENT, weeklyDigestCron as weeklyDigestCronExpression } from "@/lib/server/weekly-digest/period";
import { scheduleRoute } from "@/lib/server/schedules/config";
import { skippedForEve, type StepRunner } from "@/lib/server/schedules/core";
import { runWeeklyDigest } from "@/lib/server/schedules/jobs/weekly-digest";
import { inngest } from "../client";

/**
 * The fan-out stage. The logic is lib/server/schedules/jobs/weekly-digest.ts, shared with the eve schedule of
 * the same name: this function is a no-op while NEO_EVE_SCHEDULES lists `weekly-digest` (the eve schedule then
 * sends the same events, and `digestGenerate` below still delivers them).
 */
export const weeklyDigestCron = inngest.createFunction(
  {
    id: "weekly-digest-cron",
    name: "Fan out weekly digests",
    triggers: [{ cron: weeklyDigestCronExpression }],
    retries: 2,
    concurrency: 1,
  },
  async ({ step, event }) => {
    if (scheduleRoute("weekly-digest", "inngest") === "skip") return skippedForEve("weekly-digest");
    const steps: StepRunner = {
      run: <T>(name: string, fn: () => Promise<T>) => step.run(name, fn) as unknown as Promise<T>,
    };
    return runWeeklyDigest({
      runner: "inngest",
      steps,
      recordInStep: true,
      startedAt: new Date(event?.ts ?? Date.now()),
      deps: {
        mode: "live",
        read: getDigestServices().recipients,
        effects: { sendEvent: (id, events) => step.sendEvent(id, events) },
      },
    });
  },
);

export const digestGenerate = inngest.createFunction(
  {
    id: "weekly-digest-send",
    name: "Send a weekly digest",
    triggers: [{ event: DIGEST_GENERATE_EVENT }],
    retries: 3,
    throttle: { limit: 2, period: "1s" },
    concurrency: [
      { limit: 5, key: '\"weekly-digest\"' },
      { limit: 1, key: "event.data.userId" },
    ],
  },
  async ({ event, runId, step }) => {
    const parsed = digestGenerateEventSchema.safeParse(event.data);
    if (!parsed.success) throw new NonRetriableError("invalid neo/digest.generate payload");
    return runWeeklyDigestDelivery(parsed.data, runId, step as unknown as DigestStepTools, {
      services: getDigestServices(),
      mailer: getMailer(),
      appUrl: inboundEnv().APP_URL,
    });
  },
);
