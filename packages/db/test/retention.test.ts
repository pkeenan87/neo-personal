/**
 * Per-household retention (migration 0030_retention_settings; _specs/v2-m4-hardening.md section 1) on PGlite as the
 * non-owner app role: nullable bounded columns, per-household purges with the defaults reproducing the old global rules,
 * the read-only preview, and the memory expiry that follows the setting.
 */
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acknowledgeAlert, createAlert, getAlert, purgeOldAlerts } from "../src/alerts.js";
import { createChildRequest, getChildRequest } from "../src/child-requests.js";
import { enrollSelfDevice } from "../src/devices.js";
import { addHouseholdMemory, purgeExpiredHouseholdMemory } from "../src/household-memory.js";
import { createMemberWithoutAccount } from "../src/members.js";
import { effectiveRetention, getRetentionSettings, previewRetention, purgeOldChildRequests, setRetentionSettings } from "../src/retention.js";
import { childRequests, deviceSignals, householdMemory } from "../src/schema/index.js";
import { insertDeviceSignal, purgeOldDeviceSignals } from "../src/signals.js";
import { tenantScoped } from "../src/tenant.js";
import { createTenantForUser } from "../src/tenants.js";
import { becomeAppUser, createTestDb, createUser, type TestDb } from "./helpers.js";

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const SETTINGS = { signals: 30, incidents: 180, childRequests: 90, memory: 365 };

let t: TestDb;
let owner: string;
let tenantA: string; // default settings (null)
let tenantB: string; // shorter signals/alerts/child requests/memory
let tenantC: string; // longer
let ownerB: string;
let ownerC: string;
const device: Record<string, string> = {};
const kid: Record<string, string> = {};

async function seedSignal(tenantId: string, userId: string, days: number): Promise<string> {
  const { row } = await insertDeviceSignal(t.db, {
    tenantId,
    deviceId: device[tenantId]!,
    userId,
    clientEventId: randomUUID(),
    type: "software",
    detector: "remote_access_tool",
    subject: "anydesk",
    payload: {},
    observedAt: new Date(),
  });
  await tenantScoped(t.db, tenantId).update(deviceSignals, { receivedAt: ago(days) }, eq(deviceSignals.id, row.id));
  return row.id;
}

async function seedRequest(tenantId: string, days: number, status: "pending" | "denied" = "denied"): Promise<string> {
  const r = await createChildRequest(tenantScoped(t.db, tenantId), {
    memberId: kid[tenantId]!,
    deviceId: device[tenantId]!,
    kind: "more_time",
    detail: { minutes: 10 },
    reason: null,
    expiresAt: null,
    tokenHash: randomUUID().replace(/-/g, "").padEnd(64, "0"),
    tokenExpiresAt: new Date(Date.now() + DAY),
    now: new Date(),
  });
  if (r.outcome !== "created" && !("row" in r)) throw new Error("child request not created");
  const row = (r as { row: { id: string } }).row;
  await tenantScoped(t.db, tenantId).update(childRequests, { status, updatedAt: ago(days) }, eq(childRequests.id, row.id));
  return row.id;
}

async function seedAlert(tenantId: string, userId: string, days: number, acked: boolean): Promise<string> {
  const a = (await createAlert(t.db, {
    tenantId,
    subjectUserId: userId,
    kind: "member_verdict",
    severity: "high",
    title: "t",
    body: "b",
    dedupeKey: randomUUID(),
    now: ago(days),
  }))!;
  if (acked) await acknowledgeAlert(t.db, tenantId, a.id, userId);
  return a.id;
}

async function seedMemory(tenantId: string, userId: string, days: number): Promise<string> {
  const r = await addHouseholdMemory(tenantScoped(t.db, tenantId), { text: `fact ${randomUUID()}`, subjectMemberId: null, createdBy: userId, source: "console" });
  if (r.outcome !== "created") throw new Error("memory not created");
  // Age it: created `days` ago; expires_at keeps the original +setting.
  await tenantScoped(t.db, tenantId).update(householdMemory, { createdAt: ago(days) }, eq(householdMemory.id, r.row.id));
  return r.row.id;
}

beforeAll(async () => {
  t = await createTestDb({ createAppUserBeforeMigrations: true });
  owner = await createUser(t.db, "A");
  ownerB = await createUser(t.db, "B");
  ownerC = await createUser(t.db, "C");
  tenantA = (await createTenantForUser(t.db, { userId: owner, name: "A" })).tenantId;
  tenantB = (await createTenantForUser(t.db, { userId: ownerB, name: "B" })).tenantId;
  tenantC = (await createTenantForUser(t.db, { userId: ownerC, name: "C" })).tenantId;
  await becomeAppUser(t.client);
  for (const [tid, uid] of [[tenantA, owner], [tenantB, ownerB], [tenantC, ownerC]] as const) {
    const r = await enrollSelfDevice(t.db, { tenantId: tid, userId: uid, role: "owner", device: { kind: "desktop_agent", platform: "windows", name: "PC", clientVersion: "1" } });
    if ("error" in r) throw new Error(r.error);
    device[tid] = r.device.id;
    kid[tid] = (await createMemberWithoutAccount(tenantScoped(t.db, tid), { displayName: "Sam", role: "child", birthYear: 2016 })).id;
  }
}, 60_000);
afterAll(async () => {
  await t?.close();
});

describe("settings columns", () => {
  it("are null by default and read as the defaults", async () => {
    const stored = await getRetentionSettings(t.db, tenantA);
    expect(stored).toEqual({ signals: null, incidents: null, childRequests: null, memory: null });
    expect(effectiveRetention(stored!)).toEqual(SETTINGS);
  });

  it("enforce the bounds in the database and in setRetentionSettings", async () => {
    for (const [col, bad] of [["retention_signals_days", 6], ["retention_signals_days", 366], ["retention_incidents_days", 29], ["retention_incidents_days", 1096], ["retention_child_requests_days", 6], ["retention_memory_days", 1096]] as const) {
      await expect(
        tenantScoped(t.db, tenantA).transaction(({ tx }) => tx.execute(sql.raw(`update tenants set ${col} = ${bad} where id = '${tenantA}'`))),
      ).rejects.toThrow();
    }
    await expect(setRetentionSettings(t.db, tenantA, { ...SETTINGS, signals: 6 })).rejects.toThrow(/invalid retention/);
    await expect(setRetentionSettings(t.db, tenantA, { ...SETTINGS, memory: 1.5 })).rejects.toThrow(/invalid retention/);
    expect(await getRetentionSettings(t.db, tenantA)).toEqual({ signals: null, incidents: null, childRequests: null, memory: null });
  });

  it("are only writable for the caller's own household", async () => {
    expect(await setRetentionSettings(t.db, tenantB, { signals: 7, incidents: 30, childRequests: 7, memory: 30 })).toBe(true);
    expect(await setRetentionSettings(t.db, tenantC, { signals: 365, incidents: 1095, childRequests: 365, memory: 1095 })).toBe(true);
    expect(await getRetentionSettings(t.db, tenantA)).toEqual({ signals: null, incidents: null, childRequests: null, memory: null });
  });
});

describe("purges honour each household's settings", () => {
  it("previews without deleting, then purges the same rows", async () => {
    const sig = { a45: await seedSignal(tenantA, owner, 45), a10: await seedSignal(tenantA, owner, 10), b10: await seedSignal(tenantB, ownerB, 10), b3: await seedSignal(tenantB, ownerB, 3), c200: await seedSignal(tenantC, ownerC, 200), c400: await seedSignal(tenantC, ownerC, 400) };
    const al = {
      a100acked: await seedAlert(tenantA, owner, 100, true), // default: acknowledged after 90
      a100open: await seedAlert(tenantA, owner, 100, false),
      a200: await seedAlert(tenantA, owner, 200, false), // default: 180
      b40open: await seedAlert(tenantB, ownerB, 40, false), // 30
      b20acked: await seedAlert(tenantB, ownerB, 20, true), // 30: acknowledged cap is min(90, 30)
      c300: await seedAlert(tenantC, ownerC, 300, false), // 1095
      c100acked: await seedAlert(tenantC, ownerC, 100, true), // still 90 once acknowledged
    };
    const cr = {
      a100: await seedRequest(tenantA, 100), // 90
      a50: await seedRequest(tenantA, 50),
      b10: await seedRequest(tenantB, 10), // 7
      b5: await seedRequest(tenantB, 5),
      c200: await seedRequest(tenantC, 200), // 365
      aPending: await seedRequest(tenantA, 500, "pending"),
    };
    const mem = { a: await seedMemory(tenantA, owner, 10), b: await seedMemory(tenantB, ownerB, 40), c: await seedMemory(tenantC, ownerC, 400) };

    const exists = {
      signal: async (tid: string, id: string) => (await tenantScoped(t.db, tid).select(deviceSignals, eq(deviceSignals.id, id))).length > 0,
      request: async (tid: string, id: string) => (await getChildRequest(tenantScoped(t.db, tid), id)) !== undefined,
      alert: async (tid: string, id: string) => (await getAlert(t.db, tid, id)) !== undefined,
      memory: async (tid: string, id: string) => (await tenantScoped(t.db, tid).select(householdMemory, eq(householdMemory.id, id))).length > 0,
    };

    // Read-only preview: counts only the rows past each household's setting, and deletes nothing.
    expect(await previewRetention(t.db)).toEqual({ signals: 3, alerts: 4, childRequests: 2, householdMemory: 1 });
    expect(await exists.signal(tenantA, sig.a45)).toBe(true);
    expect(await exists.alert(tenantA, al.a200)).toBe(true);
    expect(await exists.request(tenantA, cr.a100)).toBe(true);
    expect(await exists.memory(tenantB, mem.b)).toBe(true);

    expect(await purgeOldDeviceSignals(t.db)).toBe(3);
    expect(await purgeOldAlerts(t.db)).toBe(4);
    expect(await purgeOldChildRequests(t.db)).toBe(2);
    expect(await purgeExpiredHouseholdMemory(t.db)).toBe(1);
    expect(await previewRetention(t.db)).toEqual({ signals: 0, alerts: 0, childRequests: 0, householdMemory: 0 });

    // Signals: A 30 days, B 7 days, C 365 days.
    expect([await exists.signal(tenantA, sig.a45), await exists.signal(tenantA, sig.a10)]).toEqual([false, true]);
    expect([await exists.signal(tenantB, sig.b10), await exists.signal(tenantB, sig.b3)]).toEqual([false, true]);
    expect([await exists.signal(tenantC, sig.c200), await exists.signal(tenantC, sig.c400)]).toEqual([true, false]);
    // Alerts: default 180 (acknowledged 90); B 30; C 1095 (acknowledged still 90).
    expect(await exists.alert(tenantA, al.a100acked)).toBe(false);
    expect(await exists.alert(tenantA, al.a100open)).toBe(true);
    expect(await exists.alert(tenantA, al.a200)).toBe(false);
    expect(await exists.alert(tenantB, al.b40open)).toBe(false);
    expect(await exists.alert(tenantB, al.b20acked)).toBe(true);
    expect(await exists.alert(tenantC, al.c300)).toBe(true);
    expect(await exists.alert(tenantC, al.c100acked)).toBe(false);
    // Child requests: default 90, B 7, C 365; pending ones stay.
    expect([await exists.request(tenantA, cr.a100), await exists.request(tenantA, cr.a50), await exists.request(tenantA, cr.aPending)]).toEqual([false, true, true]);
    expect([await exists.request(tenantB, cr.b10), await exists.request(tenantB, cr.b5)]).toEqual([false, true]);
    expect(await exists.request(tenantC, cr.c200)).toBe(true);
    // Memory: A 365 (10 days old), B 30 (40 days old), C 1095 (400 days old).
    expect([await exists.memory(tenantA, mem.a), await exists.memory(tenantB, mem.b), await exists.memory(tenantC, mem.c)]).toEqual([true, false, true]);
  });

  it("a new memory expires after the household's memory setting", async () => {
    const day = (id: string, tid: string) => tenantScoped(t.db, tid).select(householdMemory, eq(householdMemory.id, id));
    const b = await seedMemory(tenantB, ownerB, 0);
    const c = await seedMemory(tenantC, ownerC, 0);
    const a = await seedMemory(tenantA, owner, 0);
    const [rb] = await day(b, tenantB);
    const [rc] = await day(c, tenantC);
    const [ra] = await day(a, tenantA);
    expect(Math.round((rb!.expiresAt.getTime() - Date.now()) / DAY)).toBe(30);
    expect(Math.round((rc!.expiresAt.getTime() - Date.now()) / DAY)).toBe(1095);
    expect(Math.round((ra!.expiresAt.getTime() - Date.now()) / DAY)).toBe(365);
  });
});
