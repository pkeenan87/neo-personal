import { NonRetriableError } from "inngest";
import { inboundEnv } from "@/lib/env";
import { getMailer } from "@/lib/server/email/resend";
import { getDigestServices } from "@/lib/server/weekly-digest/services";
import { runWeeklyDigestCron, runWeeklyDigestDelivery, type DigestCronStepTools, type DigestStepTools } from "@/lib/server/weekly-digest/orchestration";
import { digestGenerateEventSchema, DIGEST_GENERATE_EVENT, weeklyDigestCron as weeklyDigestCronExpression } from "@/lib/server/weekly-digest/period";
import { inngest } from "../client";

export const weeklyDigestCron = inngest.createFunction(
  {
    id: "weekly-digest-cron",
    name: "Fan out weekly digests",
    triggers: [{ cron: weeklyDigestCronExpression }],
    retries: 2,
    concurrency: 1,
  },
  async ({ step }) => runWeeklyDigestCron(step as unknown as DigestCronStepTools, getDigestServices().recipients),
);

export const digestGenerate = inngest.createFunction(
  {
    id: "weekly-digest-send",
    name: "Send a weekly digest",
    triggers: [{ event: DIGEST_GENERATE_EVENT }],
    retries: 3,
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
