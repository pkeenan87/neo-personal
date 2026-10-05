// @vitest-environment node
import { expect, it, vi } from "vitest";
import { WEEKLY_DIGEST_TEST_AUTH_SECRET } from "./fixtures/weekly-digest";
import { runWeeklyDigestCron, runWeeklyDigestDelivery } from "@/lib/server/weekly-digest/orchestration";
import { setMemoryMembers, resetMemoryState } from "@/lib/server/memory-state";
import { createMemoryWeeklyDigestStore, createMemoryDigestRecipientStore } from "@/lib/server/weekly-digest/store";
import { MailerHttpError, type Mailer, type OutgoingEmail } from "@/lib/server/email/resend";
import type { DigestServices } from "@/lib/server/weekly-digest/data";
import type { DigestContent } from "@/lib/server/weekly-digest/content";
import type { DigestGenerateEvent } from "@/lib/server/weekly-digest/period";

const tenantId = "11111111-1111-4111-8111-111111111111";
const userId = "owner";
const event: DigestGenerateEvent = {
  tenantId,
  userId,
  scheduledAt: "2026-10-05T14:00:00.000Z",
  periodStart: "2026-09-28T14:00:00.000Z",
  periodEnd: "2026-10-05T14:00:00.000Z",
  isoWeek: "2026-W41",
};

class DurableSteps {
  readonly state = new Map<string, unknown>();
  readonly sent: Array<{ name: string; data: unknown }> = [];
  private readonly sends = new Set<string>();
  async run<T>(id: string, fn: () => Promise<T> | T): Promise<T> {
    if (this.state.has(id)) return structuredClone(this.state.get(id)) as T;
    const result = await fn();
    this.state.set(id, structuredClone(result));
    return result;
  }
  async sendEvent(id: string, events: Array<{ name: string; data: unknown }>): Promise<void> {
    if (this.sends.has(id)) return;
    this.sends.add(id);
    this.sent.push(...structuredClone(events));
  }
}

function makeServices(content: DigestContent) {
  const store = createMemoryWeeklyDigestStore();
  setMemoryMembers(tenantId, [{ userId, role: "owner", name: "Owner", email: "owner@example.test" }]);
  const services: DigestServices = {
    store,
    recipients: createMemoryDigestRecipientStore(),
    resolveRecipient: async (tenant, user) => {
      const enabled = await store.getPreference(tenant, user);
      return tenant === tenantId && user === userId && enabled
        ? { tenantId, userId, role: "owner", email: "owner@example.test" }
        : undefined;
    },
    content: { loadDigestContent: vi.fn(async () => content) },
  };
  return { store, services };
}

const reportable: DigestContent = {
  personal: {
    verdictCounts: [{ label: "malicious", count: 1 }],
    topVerdicts: [{ id: "verdict-1", label: "malicious", headline: "Suspicious sign-in", createdAt: "2026-10-01T12:00:00.000Z", href: "/verdicts/verdict-1" }],
  },
};

it("fans out ID-only events in cursor pages of at most 1,000 with a frozen period", async () => {
  const steps = new DurableSteps();
  const firstPage = Array.from({ length: 1000 }, (_, i) => ({ tenantId, userId: `user-${i}` }));
  const calls: Array<{ cursor?: string; limit?: number }> = [];
  const recipients = {
    async listDigestRecipientPairs(cursor?: string, limit?: number) {
      calls.push({ cursor, limit });
      return cursor
        ? { items: [{ tenantId, userId: "last-user" }] }
        : { items: firstPage, nextCursor: "opaque-cursor" };
    },
  };
  let clock = new Date("2026-10-05T14:03:00.000Z");
  const first = await runWeeklyDigestCron(steps, recipients, () => clock);
  clock = new Date("2026-10-12T14:03:00.000Z");
  const retry = await runWeeklyDigestCron(steps, recipients, () => clock);
  expect(first).toEqual(retry);
  expect(first.recipients).toBe(1001);
  expect(calls).toEqual([{ cursor: undefined, limit: 1000 }, { cursor: "opaque-cursor", limit: 1000 }]);
  expect(steps.sent.map(batch => batch.data)).toHaveLength(1001);
  expect(steps.sent.every(({ name, data }) => name === "neo/digest.generate" && !("email" in (data as object)))).toBe(true);
  expect(first.period.scheduledAt).toBe("2026-10-05T14:00:00.000Z");
});

it("reuses the persisted exact request on a transient provider retry", async () => {
  resetMemoryState();
  const { store, services } = makeServices(reportable);
  const steps = new DurableSteps();
  const now = new Date("2026-10-05T15:00:00.000Z");
  const attempts: OutgoingEmail[] = [];
  const mailer: Mailer = { send: vi.fn(async email => {
    attempts.push(structuredClone(email));
    if (attempts.length === 1) throw new MailerHttpError(503);
    return { id: "resend-1" };
  }) };
  const deps = { services, mailer, appUrl: "https://neo.example.test", env: { AUTH_SECRET: WEEKLY_DIGEST_TEST_AUTH_SECRET }, now: () => now };
  await expect(runWeeklyDigestDelivery(event, "run-1", steps, deps)).rejects.toBeInstanceOf(MailerHttpError);
  expect(await runWeeklyDigestDelivery(event, "run-1", steps, deps)).toEqual({ status: "sent", providerMessageId: "resend-1" });
  expect(attempts).toHaveLength(2);
  expect(attempts[0]).toEqual(attempts[1]);
  expect(attempts[0]?.idempotencyKey).toBe("digest:owner:2026-W41");
  expect(attempts[0]?.headers).toMatchObject({ "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
  expect(attempts[0]?.headers?.["List-Unsubscribe"]).toContain("https://neo.example.test/api/digest/unsubscribe?token=v1.");
  expect(services.content.loadDigestContent).toHaveBeenCalledTimes(1);
  expect((await store.getDelivery(tenantId, userId, event.isoWeek))?.state).toBe("sent");
});

it("rechecks current consent immediately before every retry and does not send after opt-out", async () => {
  resetMemoryState();
  const { store, services } = makeServices(reportable);
  const steps = new DurableSteps();
  const now = new Date("2026-10-05T15:00:00.000Z");
  const mailer: Mailer = { send: vi.fn(async () => { throw new MailerHttpError(503); }) };
  const deps = { services, mailer, appUrl: "https://neo.example.test", env: { AUTH_SECRET: WEEKLY_DIGEST_TEST_AUTH_SECRET }, now: () => now };
  await expect(runWeeklyDigestDelivery(event, "run-1", steps, deps)).rejects.toBeInstanceOf(MailerHttpError);
  await store.setPreference(tenantId, userId, false);
  expect(await runWeeklyDigestDelivery(event, "run-1", steps, deps)).toEqual({ status: "failed" });
  expect(mailer.send).toHaveBeenCalledTimes(1);
  expect((await store.getDelivery(tenantId, userId, event.isoWeek))?.state).toBe("failed");
});

it("records empty weeks without attempting email", async () => {
  resetMemoryState();
  const { store, services } = makeServices({});
  const steps = new DurableSteps();
  const mailer: Mailer = { send: vi.fn(async () => ({ id: "unexpected" })) };
  const result = await runWeeklyDigestDelivery(event, "run-1", steps, {
    services, mailer, appUrl: "https://neo.example.test", env: { AUTH_SECRET: WEEKLY_DIGEST_TEST_AUTH_SECRET }, now: () => new Date("2026-10-05T15:00:00.000Z"),
  });
  expect(result).toEqual({ status: "empty" });
  expect(mailer.send).not.toHaveBeenCalled();
  expect((await store.getDelivery(tenantId, userId, event.isoWeek))?.state).toBe("empty");
});

it("does not record a consent change during content loading as a legitimate empty week", async () => {
  resetMemoryState();
  const { store, services } = makeServices({});
  services.content.loadDigestContent = vi.fn(async () => {
    await store.setPreference(tenantId, userId, false);
    return {};
  });
  const mailer: Mailer = { send: vi.fn(async () => ({ id: "unexpected" })) };
  const result = await runWeeklyDigestDelivery(event, "run-1", new DurableSteps(), {
    services, mailer, appUrl: "https://neo.example.test", env: { AUTH_SECRET: WEEKLY_DIGEST_TEST_AUTH_SECRET }, now: () => new Date("2026-10-05T15:00:00.000Z"),
  });
  expect(result).toEqual({ status: "failed" });
  expect(mailer.send).not.toHaveBeenCalled();
  expect((await store.getDelivery(tenantId, userId, event.isoWeek))?.state).toBe("failed");
});

it("marks a Resend 4xx terminal and does not retry the send", async () => {
  resetMemoryState();
  const { store, services } = makeServices(reportable);
  const steps = new DurableSteps();
  const mailer: Mailer = { send: vi.fn(async () => { throw new MailerHttpError(400); }) };
  const deps = { services, mailer, appUrl: "https://neo.example.test", env: { AUTH_SECRET: WEEKLY_DIGEST_TEST_AUTH_SECRET }, now: () => new Date("2026-10-05T15:00:00.000Z") };
  expect(await runWeeklyDigestDelivery(event, "run-1", steps, deps)).toEqual({ status: "failed" });
  expect(await runWeeklyDigestDelivery(event, "run-1", steps, deps)).toEqual({ status: "failed" });
  expect(mailer.send).toHaveBeenCalledTimes(1);
  expect((await store.getDelivery(tenantId, userId, event.isoWeek))?.state).toBe("failed");
});

it("does not automatically resend an unresolved request after the provider's 24-hour key window", async () => {
  resetMemoryState();
  const { store, services } = makeServices(reportable);
  const steps = new DurableSteps();
  let now = new Date("2026-10-05T15:00:00.000Z");
  const mailer: Mailer = { send: vi.fn(async () => { throw new MailerHttpError(503); }) };
  const deps = { services, mailer, appUrl: "https://neo.example.test", env: { AUTH_SECRET: WEEKLY_DIGEST_TEST_AUTH_SECRET }, now: () => now };
  await expect(runWeeklyDigestDelivery(event, "run-1", steps, deps)).rejects.toBeInstanceOf(MailerHttpError);
  now = new Date(+now + 24 * 60 * 60 * 1000);
  expect(await runWeeklyDigestDelivery(event, "run-1", steps, deps)).toEqual({ status: "failed" });
  expect(mailer.send).toHaveBeenCalledTimes(1);
  expect((await store.getDelivery(tenantId, userId, event.isoWeek))?.state).toBe("failed");
});
