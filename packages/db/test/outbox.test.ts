/** The notification outbox on PGlite with the committed migrations, as the non-owner app role. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAlert, getAlert, type CreateAlertInput } from "../src/alerts.js";
import {
  OUTBOX_LEASE_MS,
  OUTBOX_MAX_ATTEMPTS,
  claimOutboxRows,
  countOutboxForAlert,
  createAlertWithOutbox,
  enqueueOutboxForAlert,
  listPendingOutboxTenants,
  markOutboxFailed,
  markOutboxSent,
  outboxDestination,
  settleAlertEmail,
  type AlertEnqueuePlan,
} from "../src/outbox.js";
import { tenantScoped } from "../src/tenant.js";
import { createTenantForUser } from "../src/tenants.js";
import { notificationOutbox } from "../src/schema/index.js";
import { becomeAppUser, createTestDb, createUser, type TestDb } from "./helpers.js";

describe("notification outbox", () => {
  let t: TestDb;
  let tenant: string;
  let other: string;
  let seq = 0;

  const input = (over: Partial<CreateAlertInput> = {}): CreateAlertInput => {
    seq += 1;
    return { tenantId: tenant, subjectUserId: null, kind: "member_left", severity: "high", title: "t", body: "b", dedupeKey: `k${seq}`, ...over };
  };
  const plan = (addresses: string[] = ["pat@example.test", "aunt@example.test"], over: Partial<AlertEnqueuePlan> = {}): AlertEnqueuePlan => ({
    cap: 1000,
    rows: (a) =>
      addresses.map((address, i) => ({ idempotencyKey: `alert:${a.id}:r${i}`, address, template: "alert", recipientMemberId: null, recipientUserId: null, payload: { resendKey: `alert:${a.id}:x${i}` } })),
    capRows: (_a, day) => [{ idempotencyKey: `alert-cap:${tenant}:${day.toISOString().slice(0, 10)}:u`, address: "pat@example.test", template: "alert_cap", recipientMemberId: null, recipientUserId: "u", payload: {} }],
    ...over,
  });
  const rowsOf = (_alertId: string) => tenantScoped(t.db, tenant).select(notificationOutbox);

  beforeAll(async () => {
    t = await createTestDb();
    await becomeAppUser(t.client);
    ({ tenantId: tenant } = await createTenantForUser(t.db, { userId: await createUser(t.db, "Pat"), name: "Pat's" }));
    ({ tenantId: other } = await createTenantForUser(t.db, { userId: await createUser(t.db, "Other"), name: "Other" }));
  });
  afterAll(async () => {
    await t.close();
  });

  it("inserts the alert and one encrypted row per recipient in one transaction", async () => {
    const r = (await createAlertWithOutbox(t.db, input(), plan()))!;
    expect(r).toMatchObject({ enqueued: 2, capped: false });
    expect(r.alert.emailStatus).toBe("pending");
    const rows = (await rowsOf(r.alert.id)).filter((x) => x.alertId === r.alert.id);
    expect(rows.map((x) => outboxDestination(x)).sort()).toEqual(["aunt@example.test", "pat@example.test"]);
    expect(rows.every((x) => !x.destinationCiphertext.includes("@") && x.channel === "email" && x.attempts === 0)).toBe(true);
  });

  it("rolls the alert back when the rows cannot be built, and a dedupe hit adds no rows", async () => {
    const dup = input({ dedupeKey: "dup" });
    await expect(createAlertWithOutbox(t.db, dup, plan([], { rows: () => { throw new Error("boom"); } }))).rejects.toThrow("boom");
    expect(await createAlertWithOutbox(t.db, dup, plan())).not.toBeNull();
    const before = (await rowsOf("")).length;
    expect(await createAlertWithOutbox(t.db, dup, plan())).toBeNull();
    expect((await rowsOf("")).length).toBe(before);
  });

  it("marks an alert with no rows skipped", async () => {
    const r = (await createAlertWithOutbox(t.db, input(), plan([])))!;
    expect(r).toMatchObject({ enqueued: 0, alert: { emailStatus: "skipped" } });
    expect((await getAlert(t.db, tenant, r.alert.id))!.emailStatus).toBe("skipped");
  });

  it("caps non-critical alerts per day with one repeat-safe notice; critical is exempt", async () => {
    // A fresh tenant so earlier alerts do not count.
    const { tenantId: capTenant } = await createTenantForUser(t.db, { userId: await createUser(t.db, "Cap"), name: "Cap" });
    const mk = (severity: CreateAlertInput["severity"]) => createAlertWithOutbox(t.db, { ...input(), tenantId: capTenant, severity }, plan(["a@example.test"], { cap: 3, capRows: (_a, d) => [{ idempotencyKey: `alert-cap:${capTenant}:${d.toISOString().slice(0, 10)}:u`, address: "a@example.test", template: "alert_cap", recipientMemberId: null, recipientUserId: "u", payload: {} }] }));
    for (let i = 0; i < 3; i++) expect((await mk("high"))!.alert.emailStatus).toBe("pending");
    const capped = (await mk("high"))!;
    expect(capped).toMatchObject({ capped: true, enqueued: 1, alert: { emailStatus: "skipped" } });
    const again = (await mk("medium"))!;
    expect(again).toMatchObject({ capped: true, enqueued: 0 });
    const crit = (await mk("critical"))!;
    expect(crit).toMatchObject({ capped: false, enqueued: 1, alert: { emailStatus: "pending" } });
    const all = await tenantScoped(t.db, capTenant).select(notificationOutbox);
    expect(all.filter((r) => r.template === "alert_cap")).toHaveLength(1);
  });

  it("claims due rows once, honours the lease, and reclaims after it expires", async () => {
    const r = (await createAlertWithOutbox(t.db, input(), plan(["x@example.test"])))!;
    const t0 = new Date("2030-01-01T00:00:00Z");
    const mine = async (now: Date) => (await claimOutboxRows(t.db, tenant, { now, limit: 200 })).filter((x) => x.alertId === r.alert.id);
    // Claim at a far-future instant so every earlier test's row is also leased, then isolate ours.
    const first = await mine(t0);
    expect(first).toHaveLength(1);
    expect(first[0]!.attempts).toBe(1);
    expect(first[0]!.leaseUntil!.getTime()).toBe(t0.getTime() + OUTBOX_LEASE_MS);
    expect(await mine(new Date(t0.getTime() + 60_000))).toHaveLength(0);
    const second = await mine(new Date(t0.getTime() + OUTBOX_LEASE_MS + 1));
    expect(second[0]!.attempts).toBe(2);
    // Another household's drain never sees it.
    expect((await claimOutboxRows(t.db, other, { now: t0 })).length).toBe(0);
  });

  it("settles the alert: sent when all rows are sent, failed when one is given up on", async () => {
    const ok = (await createAlertWithOutbox(t.db, input(), plan(["a@example.test", "b@example.test"])))!;
    const rows = (await tenantScoped(t.db, tenant).select(notificationOutbox)).filter((x) => x.alertId === ok.alert.id);
    await markOutboxSent(t.db, tenant, rows[0]!.id, "prov_1");
    expect(await settleAlertEmail(t.db, tenant, ok.alert.id)).toBeUndefined();
    await markOutboxSent(t.db, tenant, rows[1]!.id, "prov_2");
    expect(await settleAlertEmail(t.db, tenant, ok.alert.id)).toBe("sent");
    expect(await getAlert(t.db, tenant, ok.alert.id)).toMatchObject({ emailStatus: "sent" });

    const bad = (await createAlertWithOutbox(t.db, input(), plan(["c@example.test"])))!;
    const [row] = (await tenantScoped(t.db, tenant).select(notificationOutbox)).filter((x) => x.alertId === bad.alert.id);
    await markOutboxFailed(t.db, tenant, row!.id, "HTTP 422", true);
    const failed = (await tenantScoped(t.db, tenant).select(notificationOutbox)).find((x) => x.id === row!.id)!;
    expect(failed).toMatchObject({ attempts: OUTBOX_MAX_ATTEMPTS, lastError: "HTTP 422", leaseUntil: null, sentAt: null });
    expect(await settleAlertEmail(t.db, tenant, bad.alert.id)).toBe("failed");
    expect(await getAlert(t.db, tenant, bad.alert.id)).toMatchObject({ emailStatus: "failed" });
    // A row at the attempt limit is no longer claimable.
    expect((await claimOutboxRows(t.db, tenant, { now: new Date("2031-01-01T00:00:00Z"), limit: 200 })).some((x) => x.id === row!.id)).toBe(false);
  });

  it("enqueues a legacy alert once and leaves handled alerts alone", async () => {
    const legacy = (await createAlert(t.db, input()))!;
    expect(await countOutboxForAlert(t.db, tenant, legacy.id)).toBe(0);
    expect(await enqueueOutboxForAlert(t.db, tenant, legacy.id, plan())).toMatchObject({ enqueued: 2 });
    expect(await enqueueOutboxForAlert(t.db, tenant, legacy.id, plan())).toMatchObject({ enqueued: 0 });
    expect(await countOutboxForAlert(t.db, tenant, legacy.id)).toBe(2);
  });

  it("lists tenants with sendable rows to app_user through list_outbox_tenants (RLS-safe)", async () => {
    expect(await listPendingOutboxTenants(t.db)).toContain(tenant);
    // app_user still can't read the rows themselves outside the tenant context.
    const direct = await t.client.query<{ n: number }>("select count(*)::int as n from notification_outbox");
    expect(direct.rows[0]!.n).toBe(0);
  });
});
