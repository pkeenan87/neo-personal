/**
 * `signal-escalate`: triggered by `neo/signal.escalate` from lib/server/signals/escalate.ts
 * `queueSignalEscalate`. Concurrency 1 per tenant (the reputation cache and daily escalation
 * cap are shared per household), 3 retries. The step logic lives in
 * lib/server/signals/escalate.ts so it can run inline in MOCK_MODE too.
 */
import { NonRetriableError } from "inngest";
import { SIGNAL_ESCALATE_EVENT, createEscalateDeps, runSignalEscalate, type SignalEscalateData } from "@/lib/server/signals/escalate";
import { inngest } from "../client";

const UUID_RE = /^[0-9a-f-]{36}$/i;

export function parseSignalEscalateData(data: unknown): SignalEscalateData | undefined {
  const d = (data ?? {}) as Record<string, unknown>;
  const uuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);
  return uuid(d.signalId) && uuid(d.tenantId) ? { signalId: d.signalId, tenantId: d.tenantId } : undefined;
}

export const signalEscalate = inngest.createFunction(
  {
    id: "signal-escalate",
    name: "Escalate a device signal",
    triggers: [{ event: SIGNAL_ESCALATE_EVENT }],
    retries: 3,
    concurrency: { limit: 1, key: "event.data.tenantId" },
  },
  async ({ event, step }) => {
    const data = parseSignalEscalateData(event.data);
    if (!data) throw new NonRetriableError("invalid neo/signal.escalate payload");
    return step.run("escalate", () => runSignalEscalate(data, createEscalateDeps()));
  },
);
