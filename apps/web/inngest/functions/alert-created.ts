/**
 * `alert-created`: triggered by `neo/alert.created` from raiseAlert(). Emails the
 * household's owners (_specs/owner-alerts.md); the logic is in lib/server/alerts.
 */
import { NonRetriableError } from "inngest";
import { ALERT_CREATED_EVENT, createAlertDeliveryDeps, deliverAlert, type AlertCreatedData } from "@/lib/server/alerts";
import { inngest } from "../client";

export function parseAlertCreatedData(data: unknown): AlertCreatedData | undefined {
  const d = (data ?? {}) as Record<string, unknown>;
  const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);
  return uuid(d.alertId) && uuid(d.tenantId) ? { alertId: d.alertId, tenantId: d.tenantId } : undefined;
}

export const alertCreated = inngest.createFunction(
  {
    id: "alert-created",
    name: "Email an owner alert",
    triggers: [{ event: ALERT_CREATED_EVENT }],
    retries: 3,
    // One household's alerts in order, so the daily cap count is not raced.
    concurrency: { limit: 1, key: "event.data.tenantId" },
    onFailure: async ({ event }) => {
      const data = parseAlertCreatedData(event.data.event.data);
      if (data) await createAlertDeliveryDeps().markEmail(data.tenantId, data.alertId, "failed");
    },
  },
  async ({ event, step }) => {
    const data = parseAlertCreatedData(event.data);
    if (!data) throw new NonRetriableError("invalid neo/alert.created payload");
    return step.run("deliver", () => deliverAlert(data, createAlertDeliveryDeps()));
  },
);
