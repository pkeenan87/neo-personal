/**
 * `outbox-sweep` (cron every 5 minutes): drain outbox rows that are due again, such as a
 * crashed drain's expired lease (_specs/v2-m1-elder.md §6). The logic is drainPendingOutboxes().
 * Moves to an eve schedule in M3 with the other crons.
 */
import { createOutboxDrainDeps, drainPendingOutboxes } from "@/lib/server/alerts/outbox";
import { inngest } from "../client";

export const outboxSweep = inngest.createFunction(
  { id: "outbox-sweep", name: "Sweep the notification outbox", triggers: [{ cron: "*/5 * * * *" }], retries: 1, concurrency: 1 },
  async ({ step }) => step.run("sweep", () => drainPendingOutboxes(createOutboxDrainDeps())),
);
