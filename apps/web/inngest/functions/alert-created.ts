/**
 * `alert-created`: triggered by `neo/alert.created` from raiseAlert(). Drains the household's
 * notification outbox (_specs/v2-m1-elder.md §6): the alert's rows were written with it; an
 * alert with none (raised before the outbox) is enqueued first. The logic is in lib/server/alerts.
 *
 * The id stays `alert-created` so in-flight events and retries are not orphaned.
 */
import { NonRetriableError } from "inngest";
import { ALERT_CREATED_EVENT, deliverAlertNow, type AlertCreatedData } from "@/lib/server/alerts";
import { inngest } from "../client";

export function parseAlertCreatedData(data: unknown): AlertCreatedData | undefined {
  const d = (data ?? {}) as Record<string, unknown>;
  const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);
  return uuid(d.alertId) && uuid(d.tenantId) ? { alertId: d.alertId, tenantId: d.tenantId } : undefined;
}

export const alertCreated = inngest.createFunction(
  {
    id: "alert-created",
    name: "Email an alert",
    triggers: [{ event: ALERT_CREATED_EVENT }],
    // Each run spends one send attempt per due row, and a row is given up on (alert `failed`)
    // after five, so five runs exhaust it.
    retries: 4,
    // One household's drains in order.
    concurrency: { limit: 1, key: "event.data.tenantId" },
  },
  async ({ event, step }) => {
    const data = parseAlertCreatedData(event.data);
    if (!data) throw new NonRetriableError("invalid neo/alert.created payload");
    const r = await step.run("drain", () => deliverAlertNow(data));
    // Rows that failed with attempts left: let Inngest retry with backoff.
    if (r.retry > 0) throw new Error(`${r.retry} alert email(s) failed; retrying`);
    return r;
  },
);
