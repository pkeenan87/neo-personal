import { NonRetriableError } from "inngest";
import { breachMonitoringEnv } from "@/lib/env";
import { getBreachCheckService, getBreachRecipientStore } from "@/lib/server/breach-monitoring/check-services";
import { breachCheckExecutionConfig, BREACH_MAX_LOOKUP_ATTEMPTS, buildBreachCheckRetryEvent, BREACH_CHECK_EVENT, BREACH_MONITORING_WEEKLY_CRON, BREACH_TOKEN_CLEANUP_CRON, parseBreachCheckEvent } from "@/lib/server/breach-monitoring/orchestration";
import type { BreachCheckResult } from "@/lib/server/breach-monitoring/check-service";
import { scheduleRoute } from "@/lib/server/schedules/config";
import { inlineSteps, skippedForEve } from "@/lib/server/schedules/core";
import { breachMonitoringDeps, runBreachMonitoring } from "@/lib/server/schedules/jobs/breach-monitoring";
import { inngest } from "../client";

const MAX_LOOKUP_ATTEMPTS = BREACH_MAX_LOOKUP_ATTEMPTS;
const MAX_RETRY_AFTER_SECONDS = 60 * 60;
const MAX_CLEANUP_BATCHES = 100;
const PURGE_BATCH_SIZE = 1000;

function retryDelay(results: BreachCheckResult[], attempt: number): number {
  const explicit = results.flatMap((result) => result.status === "retryable_failure" && result.retryAfterSeconds ? [result.retryAfterSeconds] : []);
  return Math.min(MAX_RETRY_AFTER_SECONDS, explicit.length ? Math.max(...explicit) : 30 * 2 ** attempt);
}

/**
 * The discovery stage. The logic is lib/server/schedules/jobs/breach-monitoring.ts, shared with the eve schedule of
 * the same name: this function is a no-op while NEO_EVE_SCHEDULES lists `breach-monitoring` (the eve schedule then
 * sends the same events, and `breachCheck` below still runs the HIBP lookups).
 */
export const breachMonitoringCron = inngest.createFunction(
  {
    id: "breach-monitoring-weekly",
    name: "Queue weekly breach checks",
    triggers: [{ cron: BREACH_MONITORING_WEEKLY_CRON }],
    retries: 2,
    concurrency: 1,
  },
  async ({ step }) => {
    if (scheduleRoute("breach-monitoring", "inngest") === "skip") return skippedForEve("breach-monitoring");
    const deps = breachMonitoringDeps("live");
    if (!deps) return { queued: 0 };
    // One step: discovery decrypts every address, so it must not rerun on each replay, and the step
    // output (memoized in Inngest) must carry no addresses or digests. Events are sent from inside the
    // step and only the count is returned; event IDs are stable per run date, so a retry de-duplicates.
    return step.run("discover-and-queue", async () => {
      const { queued } = await runBreachMonitoring({ runner: "inngest", deps, steps: inlineSteps });
      return { queued };
    });
  },
);

export const breachCheck = inngest.createFunction(
  {
    id: "breach-monitoring-check",
    name: "Check monitored address with HIBP",
    triggers: [{ event: BREACH_CHECK_EVENT }],
    ...breachCheckExecutionConfig(breachMonitoringEnv().HIBP_RPM),
  },
  async ({ event, step }) => {
    const parsed = parseBreachCheckEvent({ id: event.id, name: event.name, data: event.data });
    if (!parsed) throw new NonRetriableError("invalid breach-check payload");
    const service = getBreachCheckService();
    if (!service) return { checked: 0, skipped: parsed.data.targets.length };

    const attempt = parsed.data.attempt;
    const results = await step.run(`check-attempt-${parsed.data.attempt}`, () => service.checkGroup(parsed.data.targets));
    const retryable = results.filter((result) => result.status === "retryable_failure").length;
    const failed = results.filter((result) => result.status === "failed").length;
    const skipped = results.filter((result) => result.status === "skipped").length;
    const breached = results.filter((result) => result.status === "breached").length;
    const clean = results.filter((result) => result.status === "clean").length;
    const retryScheduled = retryable > 0 && attempt + 1 < MAX_LOOKUP_ATTEMPTS;
    if (retryScheduled) {
      const delay = retryDelay(results, attempt);
      await step.sleep(`hibp-retry-wait-${attempt}`, `${delay}s`);
      await step.sendEvent(`dispatch-retry-${attempt}`, [buildBreachCheckRetryEvent(parsed)]);
    }
    return { checked: results.length, clean, breached, failed, skipped, retryable, retryScheduled };
  },
);

export const breachVerificationCleanup = inngest.createFunction(
  {
    id: "breach-verification-cleanup",
    name: "Clear expired breach-verification tokens",
    triggers: [{ cron: BREACH_TOKEN_CLEANUP_CRON }],
    retries: 2,
    concurrency: 1,
  },
  async ({ step }) => {
    const store = getBreachRecipientStore();
    if (!store) return { cleared: 0 };
    let cleared = 0;
    for (let batch = 0; batch < MAX_CLEANUP_BATCHES; batch++) {
      const count = await step.run(`purge-expired-token-hashes-${batch}`, () => store.purgeExpiredVerificationTokens());
      cleared += count;
      if (count < PURGE_BATCH_SIZE) break;
    }
    return { cleared };
  },
);
