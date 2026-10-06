/**
 * Outlook.com connector jobs (_specs/outlook-connector.md): a 15-minute poll and a daily forwarding audit. Each cron only
 * fans out one event per connected connector (identifiers only); the workers run per connector with per-tenant concurrency.
 * A Graph 429 sleeps for Retry-After (capped at one hour) inside the function, then resumes from the saved cursor.
 */
import { NonRetriableError } from "inngest";
import { outlookEnv } from "@/lib/env";
import { auditOutlookRules } from "@/lib/server/outlook/audit";
import { getOutlookDeps } from "@/lib/server/outlook/deps";
import { pollOutlookInbox } from "@/lib/server/outlook/poll";
import { getOutlookStore } from "@/lib/server/outlook/store";
import { GraphRateLimitError, MAX_RETRY_AFTER_SECONDS, type OutlookRunCtx } from "@/lib/server/outlook/types";
import { inngest } from "../client";

export const OUTLOOK_POLL_EVENT = "neo/outlook.poll";
export const OUTLOOK_AUDIT_EVENT = "neo/outlook.audit";
export const OUTLOOK_POLL_CRON = "*/15 * * * *";
export const OUTLOOK_AUDIT_CRON = "17 5 * * *";
const MAX_BATCH = 500;
const MAX_RATE_LIMIT_WAITS = 3;

export function parseOutlookEvent(data: unknown): OutlookRunCtx | undefined {
  const d = (data ?? {}) as Record<string, unknown>;
  const ok = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 100;
  return ok(d.tenantId) && ok(d.userId) && ok(d.connectorId) ? { tenantId: d.tenantId, userId: d.userId, connectorId: d.connectorId } : undefined;
}

/** One event per connected connector; the id makes a retried fan-out idempotent within its time bucket. */
async function fanOut(name: string, bucketMs: number): Promise<number> {
  if (outlookEnv().mode === "off") return 0;
  const store = getOutlookStore();
  const bucket = Math.floor(Date.now() / bucketMs);
  let cursor: string | undefined;
  let queued = 0;
  do {
    const page = await store.listConnected({ ...(cursor ? { cursor } : {}), limit: MAX_BATCH });
    if (page.items.length) {
      await inngest.send(page.items.map((i) => ({ id: `${name}:${i.connectorId}:${bucket}`, name, data: i })));
      queued += page.items.length;
    }
    cursor = page.nextCursor;
  } while (cursor);
  return queued;
}

/** Per tenant, and one run at a time per connector so a retried or overlapping event cannot race the cursor. */
export const OUTLOOK_CONCURRENCY: [{ limit: number; key: string }, { limit: number; key: string }] = [{ limit: 3, key: "event.data.tenantId" }, { limit: 1, key: "event.data.connectorId" }];

export const outlookPollCron = inngest.createFunction(
  { id: "outlook-poll-cron", name: "Queue Outlook inbox polls", triggers: [{ cron: OUTLOOK_POLL_CRON }], retries: 2, concurrency: 1 },
  async ({ step }) => ({ queued: await step.run("fan-out", () => fanOut(OUTLOOK_POLL_EVENT, 15 * 60_000)) }),
);

export const outlookAuditCron = inngest.createFunction(
  { id: "outlook-audit-cron", name: "Queue Outlook forwarding audits", triggers: [{ cron: OUTLOOK_AUDIT_CRON }], retries: 2, concurrency: 1 },
  async ({ step }) => ({ queued: await step.run("fan-out", () => fanOut(OUTLOOK_AUDIT_EVENT, 24 * 60 * 60_000)) }),
);

export const outlookPoll = inngest.createFunction(
  { id: "outlook-poll", name: "Poll an Outlook inbox for sign-in alerts", triggers: [{ event: OUTLOOK_POLL_EVENT }], retries: 3, concurrency: OUTLOOK_CONCURRENCY },
  async ({ event, step }) => {
    const ctx = parseOutlookEvent(event.data);
    if (!ctx) throw new NonRetriableError("invalid outlook poll payload");
    const deps = getOutlookDeps();
    if (!deps) return { status: "disabled" };
    for (let n = 0; ; n++) {
      const result = await step.run(`poll-${n}`, () => pollOutlookInbox(ctx, deps));
      if (result.status !== "rate_limited" || n >= MAX_RATE_LIMIT_WAITS) return result;
      await step.sleep(`rate-limit-wait-${n}`, `${Math.min(MAX_RETRY_AFTER_SECONDS, result.retryAfterSeconds ?? 60)}s`);
    }
  },
);

export const outlookAudit = inngest.createFunction(
  { id: "outlook-audit", name: "Audit an Outlook inbox for forwarding rules", triggers: [{ event: OUTLOOK_AUDIT_EVENT }], retries: 3, concurrency: OUTLOOK_CONCURRENCY },
  async ({ event, step }) => {
    const ctx = parseOutlookEvent(event.data);
    if (!ctx) throw new NonRetriableError("invalid outlook audit payload");
    const deps = getOutlookDeps();
    if (!deps) return { status: "disabled" };
    for (let n = 0; ; n++) {
      const result = await step.run(`audit-${n}`, async () => {
        try {
          return await auditOutlookRules(ctx, deps);
        } catch (err) {
          if (err instanceof GraphRateLimitError) return { status: "rate_limited" as const, retryAfterSeconds: err.retryAfterSeconds };
          throw err;
        }
      });
      if (result.status !== "rate_limited" || n >= MAX_RATE_LIMIT_WAITS) return result;
      await step.sleep(`rate-limit-wait-${n}`, `${Math.min(MAX_RETRY_AFTER_SECONDS, result.retryAfterSeconds)}s`);
    }
  },
);
