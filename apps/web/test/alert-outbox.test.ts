// @vitest-environment node
/**
 * Alert email through the notification outbox on the in-memory stores
 * (_specs/v2-m1-elder.md §6): recipients incl. Elder helpers, enqueue with the alert,
 * the drain (lease, retry, give-up), the daily cap and legacy alerts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALERT_EMAIL_DAILY_CAP, deliverAlertNow, raiseAlert } from "@/lib/server/alerts";
import { createOutboxDrainDeps, drainOutbox, drainPendingOutboxes, enqueueIfLegacy } from "@/lib/server/alerts/outbox";
import { MailerHttpError } from "@/lib/server/email/resend";
import { memorySentEmails } from "@/lib/server/email/resend";
import { memoryAlertRows, memoryCreateAlert, memoryOutboxRows, memorySetThreshold, resetMemoryAlerts } from "@/lib/server/memory-alerts";
import { addMemoryContactMember, resetMemoryProtection, setMemoryMemberMode } from "@/lib/server/memory-members";
import { setMemoryMembers } from "@/lib/server/memory-state";
import { resetMemoryDevices } from "@/lib/server/memory-devices";
import { resetMemoryState, stubBaseEnv } from "./helpers/routes";

const TENANT = "00000000-0000-4000-8000-0000000000b1";
const PAT = { userId: "user-pat", name: "Pat", email: "pat@example.test", role: "owner" as const };
const GRAN = { userId: "user-gran", name: "Gran", email: "gran@example.test", role: "member" as const };
const SON = { userId: "user-son", name: "Son", email: "son@example.test", role: "member" as const };
const IDS = { pat: "00000000-0000-4000-8000-00000000a001", gran: "00000000-0000-4000-8000-00000000a002", son: "00000000-0000-4000-8000-00000000a003", aunt: "00000000-0000-4000-8000-00000000a004" };

let seq = 0;
function raise(over: Partial<Parameters<typeof raiseAlert>[0]> = {}) {
  seq += 1;
  return raiseAlert({
    tenantId: TENANT,
    subjectUserId: GRAN.userId,
    kind: "install_during_session",
    severity: "critical",
    title: "Stop and hang up: Gran may be on a scam call",
    body: "A remote-access session was followed by an install.",
    dedupeKey: `t:${seq}`,
    ...over,
  });
}

const failing = (status: number) => ({
  send: async () => {
    throw new MailerHttpError(status);
  },
});

beforeEach(() => {
  stubBaseEnv(vi);
  vi.stubEnv("DEV_AUTH_BYPASS", "false");
  vi.stubEnv("INNGEST_EVENT_KEY", "");
  vi.stubEnv("AUTH_URL", "https://neo.example.test");
  resetMemoryState();
  resetMemoryAlerts();
  resetMemoryProtection();
  resetMemoryDevices();
  memorySentEmails().length = 0;
  setMemoryMembers(TENANT, [PAT, GRAN, SON]);
  setMemoryMemberMode(TENANT, PAT.userId, "standard", IDS.pat);
  setMemoryMemberMode(TENANT, GRAN.userId, "elder", IDS.gran, [IDS.son, IDS.aunt]);
  setMemoryMemberMode(TENANT, SON.userId, "standard", IDS.son);
  addMemoryContactMember(TENANT, { id: IDS.aunt, displayName: "Aunt", contact: "aunt@example.test" });
});
afterEach(() => vi.unstubAllEnvs());

describe("enqueue and drain", () => {
  it("emails the owner and the Elder member's helpers, never the Elder member", async () => {
    const alert = (await raise())!;
    expect(alert.emailStatus).toBe("sent");
    const sent = memorySentEmails();
    expect(sent.map((e) => e.to).sort()).toEqual(["aunt@example.test", "pat@example.test", "son@example.test"]);

    // Owners and account holders keep Phase 3's Resend key; contact-only helpers use their member id.
    expect(Object.fromEntries(sent.map((e) => [e.to, e.idempotencyKey]))).toEqual({
      "pat@example.test": `alert:${alert.id}:${PAT.userId}`,
      "son@example.test": `alert:${alert.id}:${SON.userId}`,
      "aunt@example.test": `alert:${alert.id}:m:${IDS.aunt}`,
    });
    expect(memoryOutboxRows().map((o) => o.idempotencyKey).sort()).toEqual([`alert:${alert.id}:${IDS.aunt}`, `alert:${alert.id}:${IDS.pat}`, `alert:${alert.id}:${IDS.son}`].sort());
    expect(memoryOutboxRows().every((o) => o.sentAt && o.providerId)).toBe(true);
    // The destination is stored encrypted.
    expect(memoryOutboxRows().some((o) => o.destinationCiphertext.includes("@"))).toBe(false);
  });

  it("sends helpers the templated variant that names the member, and owners the usual email", async () => {
    await raise();
    const byTo = (to: string) => memorySentEmails().find((e) => e.to === to)!;
    expect(byTo("aunt@example.test").text.startsWith("Stop, hang up, and call Gran.")).toBe(true);
    expect(byTo("aunt@example.test").text).not.toContain("https://neo.example.test");
    expect(byTo("son@example.test").text).toContain("https://neo.example.test/settings/household");
    expect(byTo("pat@example.test").text.startsWith("Stop and hang up")).toBe(true);
  });

  it("names the member and device for a non-critical helper email", async () => {
    await raise({ severity: "high", title: "Gran's laptop installed something", kind: "unwanted_software" });
    const aunt = memorySentEmails().find((e) => e.to === "aunt@example.test")!;
    expect(aunt.text.startsWith("This is about Gran's devices.")).toBe(true);
  });

  it("does not tell helpers below helpersNotifyAt", async () => {
    memorySetThreshold(TENANT, PAT.userId, "medium");
    await raise({ severity: "medium" });
    expect(memorySentEmails().map((e) => e.to)).toEqual(["pat@example.test"]);
  });

  it("still emails a Standard-mode owner about their own device", async () => {
    await raise({ subjectUserId: PAT.userId, severity: "high" });
    expect(memorySentEmails().map((e) => e.to)).toEqual(["pat@example.test"]);
  });

  it("does not email an Elder owner about themselves", async () => {
    setMemoryMemberMode(TENANT, PAT.userId, "elder", IDS.pat);
    const a = (await raise({ subjectUserId: PAT.userId }))!;
    expect(memorySentEmails()).toHaveLength(0);
    expect(a.emailStatus).toBe("skipped");
    expect(memoryOutboxRows()).toHaveLength(0);
  });

  it("a replayed event or a second drain sends once", async () => {
    const alert = (await raise())!;
    await deliverAlertNow({ alertId: alert.id, tenantId: TENANT });
    await deliverAlertNow({ alertId: alert.id, tenantId: TENANT });
    expect(memorySentEmails()).toHaveLength(3);
    expect(memoryOutboxRows()).toHaveLength(3);
  });

  it("a dedupe hit enqueues nothing", async () => {
    await raise({ dedupeKey: "same" });
    const before = memoryOutboxRows().length;
    expect(await raise({ dedupeKey: "same" })).toBeNull();
    expect(memoryOutboxRows()).toHaveLength(before);
  });

  it("skips an alert with no mailer or no eligible recipient", async () => {
    memorySetThreshold(TENANT, PAT.userId, "off");
    setMemoryMemberMode(TENANT, GRAN.userId, "elder", IDS.gran, []);
    const a = (await raise())!;
    expect(a.emailStatus).toBe("skipped");
    expect(memoryOutboxRows()).toHaveLength(0);
  });
});

describe("leases, retries and giving up", () => {
  async function pending() {
    // Enqueue only: leave the rows for the drains under test.
    vi.stubEnv("INNGEST_EVENT_KEY", "evt_test");
    const { inngest } = await import("@/inngest/client");
    const spy = vi.spyOn(inngest, "send").mockResolvedValue({ ids: [] } as never);
    const alert = (await raise())!;
    spy.mockRestore();
    vi.stubEnv("INNGEST_EVENT_KEY", "");
    return alert;
  }

  it("overlapping drains do not claim the same row; an expired lease is retried", async () => {
    await pending();
    const deps = createOutboxDrainDeps();
    const t0 = new Date("2026-11-02T12:00:00Z");
    const first = await deps.claim(TENANT, t0, 50);
    expect(first).toHaveLength(3);
    expect(await deps.claim(TENANT, new Date(t0.getTime() + 60_000), 50)).toHaveLength(0);
    const later = await deps.claim(TENANT, new Date(t0.getTime() + 3 * 60_000), 50);
    expect(later).toHaveLength(3);
    expect(later.every((r) => r.attempts === 2)).toBe(true);
    expect(memorySentEmails()).toHaveLength(0);
  });

  it("a crashed drain's rows are sent by the sweep once the lease expires", async () => {
    await pending();
    const deps = createOutboxDrainDeps();
    const t0 = new Date("2026-11-02T12:00:00Z");
    await deps.claim(TENANT, t0, 50); // crashed before sending
    expect((await drainPendingOutboxes(deps, new Date(t0.getTime() + 60_000))).claimed).toBe(0);
    const r = await drainPendingOutboxes(deps, new Date(t0.getTime() + 3 * 60_000));
    expect(r).toMatchObject({ claimed: 3, sent: 3 });
    expect(memoryAlertRows()[0]!.emailStatus).toBe("sent");
  });

  it("gives up after five failed attempts and marks the alert failed", async () => {
    const alert = await pending();
    const deps = { ...createOutboxDrainDeps(), mailer: failing(500) };
    for (let i = 1; i <= 4; i++) {
      expect(await drainOutbox(TENANT, deps, new Date(), { alertId: alert.id })).toMatchObject({ claimed: 3, retry: 3, gaveUp: 0 });
      expect(memoryAlertRows()[0]!.emailStatus).toBe("pending");
    }
    expect(await drainOutbox(TENANT, deps, new Date(), { alertId: alert.id })).toMatchObject({ claimed: 3, retry: 0, gaveUp: 3 });
    expect(memoryAlertRows()[0]!.emailStatus).toBe("failed");
    expect(memoryOutboxRows()[0]!.lastError).toContain("HTTP 500");
    expect(await drainOutbox(TENANT, deps, new Date())).toMatchObject({ claimed: 0 });
  });

  it("a permanent 4xx is not retried", async () => {
    const alert = await pending();
    const deps = { ...createOutboxDrainDeps(), mailer: failing(422) };
    expect(await drainOutbox(TENANT, deps, new Date(), { alertId: alert.id })).toMatchObject({ claimed: 3, retry: 0, gaveUp: 3 });
    expect(memoryOutboxRows().every((o) => o.attempts === 5)).toBe(true);
    expect(memoryAlertRows()[0]!.emailStatus).toBe("failed");
  });

  it("a rate limit (429) is retried", async () => {
    const alert = await pending();
    const deps = { ...createOutboxDrainDeps(), mailer: failing(429) };
    expect(await drainOutbox(TENANT, deps, new Date(), { alertId: alert.id })).toMatchObject({ retry: 3, gaveUp: 0 });
  });
});

describe("daily cap", () => {
  it("sends a notice once for a capped alert and stops emailing non-critical alerts", async () => {
    for (let i = 0; i < ALERT_EMAIL_DAILY_CAP; i++) await raise({ subjectUserId: PAT.userId, severity: "high", kind: "unwanted_software" });
    expect(memoryAlertRows().filter((a) => a.emailStatus === "sent")).toHaveLength(ALERT_EMAIL_DAILY_CAP);
    const emailed = memorySentEmails().length;

    const capped = (await raise({ subjectUserId: PAT.userId, severity: "high", kind: "unwanted_software" }))!;
    expect(capped.emailStatus).toBe("skipped");
    const date = new Date().toISOString().slice(0, 10);
    const notice = memorySentEmails().slice(emailed);
    expect(notice).toHaveLength(1);
    expect(notice[0]).toMatchObject({ to: PAT.email, idempotencyKey: `alert-cap:${TENANT}:${date}:${PAT.userId}`, subject: "Neo alert: more alerts than usual today" });

    await raise({ subjectUserId: PAT.userId, severity: "high", kind: "unwanted_software" });
    expect(memorySentEmails()).toHaveLength(emailed + 1);
  });

  it("critical alerts are exempt from the cap", async () => {
    for (let i = 0; i < ALERT_EMAIL_DAILY_CAP; i++) await raise({ subjectUserId: PAT.userId, severity: "high", kind: "unwanted_software" });
    const critical = (await raise({ subjectUserId: PAT.userId, severity: "critical" }))!;
    expect(critical.emailStatus).toBe("sent");
    expect(memorySentEmails().at(-1)).toMatchObject({ to: PAT.email, idempotencyKey: `alert:${critical.id}:${PAT.userId}` });
  });
});

describe("legacy alerts", () => {
  it("an alert raised before the outbox, with no rows, is enqueued and sent by the drain", async () => {
    const legacy = memoryCreateAlert({ tenantId: TENANT, subjectUserId: GRAN.userId, kind: "scam_in_progress", severity: "critical", title: "t", body: "b", dedupeKey: "legacy" })!;
    expect(memoryOutboxRows()).toHaveLength(0);
    expect(await deliverAlertNow({ alertId: legacy.id, tenantId: TENANT })).toMatchObject({ enqueued: 3 });
    expect(memorySentEmails().map((e) => e.to).sort()).toEqual(["aunt@example.test", "pat@example.test", "son@example.test"]);
    expect(memoryAlertRows()[0]!.emailStatus).toBe("sent");
    // Replaying the event does nothing.
    expect(await enqueueIfLegacy(TENANT, legacy.id)).toBe(0);
  });
});
