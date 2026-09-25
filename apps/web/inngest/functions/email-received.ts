/**
 * `email-received`: triggered by `neo/email.received` from POST /api/inbound/resend.
 * The step logic lives in lib/server/inbound/email-received-job.ts.
 */
import { NonRetriableError } from "inngest";
import { createEmailJobDeps } from "@/lib/server/inbound/deps";
import {
  EMAIL_RECEIVED_EVENT,
  handleEmailReceivedFailure,
  runEmailReceived,
  type EmailReceivedData,
  type StepRunner,
} from "@/lib/server/inbound/email-received-job";
import { inngest } from "../client";

export function parseEmailReceivedData(data: unknown): EmailReceivedData | undefined {
  const d = (data ?? {}) as Record<string, unknown>;
  const ok = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200;
  return ok(d.inboundMessageId) && ok(d.tenantId) && ok(d.emailId)
    ? { inboundMessageId: d.inboundMessageId, tenantId: d.tenantId, emailId: d.emailId }
    : undefined;
}

export const emailReceived = inngest.createFunction(
  {
    id: "email-received",
    name: "Analyze a forwarded email",
    triggers: [{ event: EMAIL_RECEIVED_EVENT }],
    retries: 3,
    concurrency: { limit: 5, key: "event.data.tenantId" },
    timeouts: { finish: "4m" },
    onFailure: async ({ event, error }) => {
      const data = parseEmailReceivedData(event.data.event.data);
      if (data) await handleEmailReceivedFailure(data, createEmailJobDeps(), error);
    },
  },
  async ({ event, step }) => {
    const data = parseEmailReceivedData(event.data);
    if (!data) throw new NonRetriableError("invalid neo/email.received payload");
    const steps: StepRunner = {
      run: <T>(name: string, fn: () => Promise<T>) => step.run(name, fn) as unknown as Promise<T>,
    };
    return runEmailReceived(data, createEmailJobDeps(), steps);
  },
);
