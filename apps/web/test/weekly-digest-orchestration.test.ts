// @vitest-environment node
import { expect, it, vi } from "vitest";
import { WEEKLY_DIGEST_TEST_AUTH_SECRET } from "./fixtures/weekly-digest";
import { runWeeklyDigestCron, runWeeklyDigestDelivery } from "@/lib/server/weekly-digest/orchestration";
import { setMemoryMembers, resetMemoryState } from "@/lib/server/memory-state";
import { createMemoryWeeklyDigestStore, createMemoryDigestRecipientStore } from "@/lib/server/weekly-digest/store";
import { MailerHttpError, createMockMailer, memorySentEmails, type Mailer, type OutgoingEmail } from "@/lib/server/email/resend";
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
  let role: "owner" | "member" = "owner";
  const setRole = (next: "owner" | "member") => {
    role = next;
    setMemoryMembers(tenantId, [{ userId, role, name: "Owner", email: "owner@example.test" }]);
  };
  setRole("owner");
  const services: DigestServices = {
    store,
    recipients: createMemoryDigestRecipientStore(),
    resolveRecipient: async (tenant, user) => {
      const enabled = await store.getPreference(tenant, user);
      return tenant === tenantId && user === userId && enabled
        ? { tenantId, userId, role, email: "owner@example.test" }
        : undefined;
    },
    content: { loadDigestContent: vi.fn(async () => content) },
  };
  return { store, services, setRole };
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
  const durableState = JSON.stringify([...steps.state.values()]);
  expect(durableState).not.toMatch(/owner@example\.test|<html|List-Unsubscribe|v1\./);
  expect(await runWeeklyDigestDelivery(event, "run-1", steps, deps)).toEqual({ status: "sent", providerMessageId: "resend-1" });
  expect(attempts).toHaveLength(2);
  expect(attempts[0]).toEqual(attempts[1]);
  expect(attempts[0]?.idempotencyKey).toBe("digest:owner:2026-W41");
  expect(attempts[0]?.headers).toMatchObject({ "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
  expect(attempts[0]?.headers?.["List-Unsubscribe"]).toContain("https://neo.example.test/api/digest/unsubscribe?token=v1.");
  expect(services.content.loadDigestContent).toHaveBeenCalledTimes(1);
  expect((await store.getDelivery(tenantId, userId, event.isoWeek))?.state).toBe("sent");
});

it("reuses the encrypted request byte-for-byte when a new run takes over a stale lease", async () => {
  resetMemoryState();
  const { store, services } = makeServices(reportable);
  services.content.loadDigestContent = vi.fn()
    .mockResolvedValueOnce(reportable)
    .mockResolvedValueOnce({ personal: { ...reportable.personal, topVerdicts: [{ ...reportable.personal!.topVerdicts![0]!, headline: "Different after retry" }] } });
  const firstSteps = new DurableSteps();
  let now = new Date("2026-10-05T15:00:00.000Z");
  const attempts: OutgoingEmail[] = [];
  const mailer: Mailer = { send: vi.fn(async email => {
    attempts.push(structuredClone(email));
    if (attempts.length === 1) throw new MailerHttpError(503);
    return { id: "resend-2" };
  }) };
  const deps = { services, mailer, appUrl: "https://neo.example.test", env: { AUTH_SECRET: WEEKLY_DIGEST_TEST_AUTH_SECRET }, now: () => now };
  await expect(runWeeklyDigestDelivery(event, "run-1", firstSteps, deps)).rejects.toBeInstanceOf(MailerHttpError);
  now = new Date(+now + 16 * 60_000);
  const secondSteps = new DurableSteps();
  expect(await runWeeklyDigestDelivery(event, "run-2", secondSteps, deps)).toEqual({ status: "sent", providerMessageId: "resend-2" });
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(services.content.loadDigestContent).toHaveBeenCalledTimes(1);
  const state = JSON.stringify([...secondSteps.state.values()]);
  expect(state).not.toContain("owner@example.test");
  expect(state).not.toContain("<html");
  expect(state).not.toContain("List-Unsubscribe");
  expect(state).not.toContain("v1.");
  expect((await store.getDelivery(tenantId, userId, event.isoWeek))?.runId).toBe("run-2");
});

it("blocks send if the recipient role changes after prepare", async () => {
  resetMemoryState();
  const { store, services, setRole } = makeServices(reportable);
  await store.setPreference(tenantId, userId, true);
  const mailer: Mailer = { send: vi.fn(async () => ({ id: "msg-role" })) };
  class RoleChangeSteps extends DurableSteps {
    override async run<T>(id: string, fn: () => Promise<T> | T): Promise<T> {
      if (id === "digest-send-email") setRole("member");
      return super.run(id, fn);
    }
  }
  const result = await runWeeklyDigestDelivery(event, "run-role-change", new RoleChangeSteps(), {
    services, appUrl: "https://neo.example.test",
    env: { AUTH_SECRET: WEEKLY_DIGEST_TEST_AUTH_SECRET, RESEND_FROM_EMAIL: "Neo <security@neo.example.test>" }, mailer, now: () => new Date("2026-10-05T14:00:00Z"),
  });
  expect(result.status).toBe("failed");
  expect(mailer.send).not.toHaveBeenCalled();
  expect(await store.getDelivery(tenantId, userId, event.isoWeek)).toMatchObject({ state: "failed" });
  expect(await store.getPayload({ tenantId, userId, isoWeek: event.isoWeek, runId: "run-role-change" })).toBeUndefined();
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

it("skips a week with only a hardening score or only breach status, and includes the score when there is activity", async () => {
  const run = async (content: DigestContent) => {
    resetMemoryState();
    const { store, services } = makeServices(content);
    await store.setPreference(tenantId, userId, true);
    const mailer: Mailer = { send: vi.fn(async () => ({ id: "m-1" })) };
    const result = await runWeeklyDigestDelivery(event, "run-1", new DurableSteps(), {
      services, mailer, appUrl: "https://neo.example.test",
      env: { AUTH_SECRET: WEEKLY_DIGEST_TEST_AUTH_SECRET, RESEND_FROM_EMAIL: "Neo <security@neo.example.test>" }, now: () => new Date("2026-10-05T15:00:00.000Z"),
    });
    return { result, mailer, state: (await store.getDelivery(tenantId, userId, event.isoWeek))?.state };
  };
  const score = { hardeningScore: { scorePercent: 45, href: "/settings/hardening" } };
  const scoreOnly = await run(score);
  expect(scoreOnly.result).toEqual({ status: "empty" });
  expect(scoreOnly.mailer.send).not.toHaveBeenCalled();
  expect(scoreOnly.state).toBe("empty");
  const breachOnly = await run({ breachStatus: { status: "clear" } } as unknown as DigestContent);
  expect(breachOnly.result).toEqual({ status: "empty" });
  expect(breachOnly.mailer.send).not.toHaveBeenCalled();
  const withActivity = await run({ ...reportable, ...score });
  expect(withActivity.result).toMatchObject({ status: "sent" });
  expect(JSON.stringify(vi.mocked(withActivity.mailer.send).mock.calls[0])).toContain("45%");
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

it.each([408, 409, 429])("retries Resend %s without terminally failing or clearing the encrypted request", async (status) => {
  resetMemoryState();
  const { store, services } = makeServices(reportable);
  const steps = new DurableSteps();
  let attempts = 0;
  const mailer: Mailer = { send: vi.fn(async () => {
    attempts++;
    if (attempts === 1) throw new MailerHttpError(status);
    return { id: `resend-after-${status}` };
  }) };
  const deps = { services, mailer, appUrl: "https://neo.example.test", env: { AUTH_SECRET: WEEKLY_DIGEST_TEST_AUTH_SECRET }, now: () => new Date("2026-10-05T15:00:00.000Z") };
  await expect(runWeeklyDigestDelivery(event, "run-1", steps, deps)).rejects.toMatchObject({ status });
  expect((await store.getDelivery(tenantId, userId, event.isoWeek))?.state).toBe("sending");
  expect(await store.getPayload({ tenantId, userId, isoWeek: event.isoWeek, runId: "run-1" })).toBeInstanceOf(Uint8Array);
  expect(await runWeeklyDigestDelivery(event, "run-1", steps, deps)).toEqual({ status: "sent", providerMessageId: `resend-after-${status}` });
  expect(attempts).toBe(2);
});

it("fails closed in deployed environments when the payload master key is absent", async () => {
  resetMemoryState();
  const { store, services } = makeServices(reportable);
  const mailer: Mailer = { send: vi.fn(async () => ({ id: "unexpected" })) };
  const result = await runWeeklyDigestDelivery(event, "run-1", new DurableSteps(), {
    services, mailer, appUrl: "https://neo.example.test", env: { NODE_ENV: "production", AUTH_SECRET: WEEKLY_DIGEST_TEST_AUTH_SECRET }, now: () => new Date("2026-10-05T15:00:00.000Z"),
  });
  expect(result).toEqual({ status: "failed" });
  expect(mailer.send).not.toHaveBeenCalled();
  expect(await store.getPayload({ tenantId, userId, isoWeek: event.isoWeek, runId: "run-1" })).toBeUndefined();
  expect((await store.getDelivery(tenantId, userId, event.isoWeek))?.state).toBe("failed");
});

it("does not send a prepared owner digest after the recipient becomes a member", async () => {
  resetMemoryState();
  const { store, services, setRole } = makeServices(reportable);
  await store.setPreference(tenantId, userId, true);
  class RoleChangesBeforeSend extends DurableSteps {
    override async run<T>(id: string, fn: () => Promise<T> | T): Promise<T> {
      if (id === "digest-send-email") setRole("member");
      return super.run(id, fn);
    }
  }
  const mailer: Mailer = { send: vi.fn(async () => ({ id: "unexpected" })) };
  const result = await runWeeklyDigestDelivery(event, "run-1", new RoleChangesBeforeSend(), {
    services, mailer, appUrl: "https://neo.example.test", env: { AUTH_SECRET: WEEKLY_DIGEST_TEST_AUTH_SECRET }, now: () => new Date("2026-10-05T15:00:00.000Z"),
  });
  expect(result).toEqual({ status: "failed" });
  expect(mailer.send).not.toHaveBeenCalled();
  expect((await store.getDelivery(tenantId, userId, event.isoWeek))?.state).toBe("failed");
  expect(await store.getPayload({ tenantId, userId, isoWeek: event.isoWeek, runId: "run-1" })).toBeUndefined();
});

it("records a mock-mode digest in memorySentEmails on localhost", async () => {
  resetMemoryState();
  memorySentEmails().length = 0;
  const { services } = makeServices(reportable);
  const result = await runWeeklyDigestDelivery(event, "run-mock", new DurableSteps(), {
    services,
    mailer: createMockMailer("Neo <security@neo.example.test>"),
    appUrl: "http://localhost:3210",
    env: { MOCK_MODE: "true" },
    now: () => new Date("2026-10-05T15:00:00.000Z"),
  });
  expect(result.status).toBe("sent");
  expect(memorySentEmails()).toHaveLength(1);
  expect(memorySentEmails()[0]?.to).toBe("owner@example.test");
  expect(memorySentEmails()[0]?.html).toContain("http://localhost:3210/api/digest/unsubscribe");
});

it("purges stale in-memory encrypted payloads after 24 hours", async () => {
  resetMemoryState();
  const store = createMemoryWeeklyDigestStore();
  const now = new Date("2026-10-05T14:00:00Z");
  const claim = {
    tenantId, userId, isoWeek: event.isoWeek,
    periodStart: new Date(event.periodStart), periodEnd: new Date(event.periodEnd),
    runId: "run-memory-purge", now,
  };
  expect((await store.claimDelivery(claim)).result).toBe("claimed");
  const ciphertext = new Uint8Array([7, 8, 9]);
  expect(await store.savePayload({ ...claim, payload: ciphertext })).toBe(true);
  const takeover = { ...claim, runId: "run-memory-purge-late", now: new Date(+now + 23 * 60 * 60_000) };
  expect((await store.claimDelivery(takeover)).result).toBe("claimed");
  expect(await store.getPayload({ tenantId, userId, isoWeek: event.isoWeek, runId: takeover.runId })).toEqual(ciphertext);
  expect(await store.purgeStalePayloads(new Date(+now + 24 * 60 * 60_000))).toBe(1);
  expect(await store.getPayload({ tenantId, userId, isoWeek: event.isoWeek, runId: takeover.runId })).toBeUndefined();
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
