// @vitest-environment node
import { expect, it, vi } from "vitest";
import { functions } from "@/inngest/functions";
import { digestGenerate, weeklyDigestCron } from "@/inngest/functions/weekly-digest";

const mocks = vi.hoisted(() => ({
  services: {
    recipients: { listDigestRecipientPairs: vi.fn(async () => ({ items: [] as Array<{ tenantId: string; userId: string }> })) },
  },
}));
vi.mock("@/lib/server/weekly-digest/services", () => ({ getDigestServices: () => mocks.services }));

it("registers the weekly UTC cron and the typed per-recipient event function", () => {
  expect(weeklyDigestCron.opts.triggers).toContainEqual({ cron: "TZ=UTC 0 14 * * 1" });
  expect(digestGenerate.opts.triggers).toContainEqual({ event: "neo/digest.generate" });
  expect(functions).toContain(weeklyDigestCron);
  expect(functions).toContain(digestGenerate);
  const limits = digestGenerate.opts.concurrency;
  expect(Array.isArray(limits)).toBe(true);
  expect(limits).toHaveLength(2);
  expect(limits).toContainEqual(expect.objectContaining({ limit: 5 }));
  expect(limits).toContainEqual(expect.objectContaining({ limit: 1, key: "event.data.userId" }));
});

it("runs the v4 cron handler without an event argument", async () => {
  const handler = (weeklyDigestCron as unknown as {
    fn: (context: { step: { run<T>(id: string, fn: () => T | Promise<T>): Promise<T>; sendEvent(id: string, events: unknown[]): Promise<unknown> } }) => Promise<unknown>;
  }).fn;
  const step = {
    run: async <T>(_id: string, fn: () => T | Promise<T>) => fn(),
    sendEvent: vi.fn(async () => ({ ids: [] })),
  };
  const result = await handler({ step });
  expect(result).toMatchObject({ recipients: 0, period: { scheduledAt: expect.any(String) } });
  expect(step.sendEvent).not.toHaveBeenCalled();
  expect(mocks.services.recipients.listDigestRecipientPairs).toHaveBeenCalledWith(undefined, 1000);
});
