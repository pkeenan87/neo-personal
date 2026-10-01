/**
 * Device signals, expected tools and the shared reputation cache on PGlite with the
 * committed migrations, as the non-owner app role (_specs/signals.md).
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAlert } from "../src/alerts.js";
import { enrollSelfDevice, revokeDevice } from "../src/devices.js";
import { alerts, deviceSignals, reputationCache, verdicts } from "../src/schema/index.js";
import {
  PostgresReputationCache,
  countDeviceSignalsSince,
  getDeviceSignal,
  insertDeviceSignal,
  listDeviceSignalsByClientIds,
  listExpectedTools,
  listRecentUserSignals,
  purgeExpiredReputationCache,
  purgeOldDeviceSignals,
  setExpectedTools,
  updateDeviceSignal,
} from "../src/signals.js";
import { tenantScoped } from "../src/tenant.js";
import { createTenantForUser } from "../src/tenants.js";
import { becomeAppUser, createTestDb, createUser, type TestDb } from "./helpers.js";

const DAY = 24 * 60 * 60 * 1000;

async function household(t: TestDb) {
  const ownerId = await createUser(t.db, "Pat");
  const { tenantId } = await createTenantForUser(t.db, { userId: ownerId, name: "Pat's household" });
  return { ownerId, tenantId };
}

async function enrolledDevice(t: TestDb, tenantId: string, userId: string) {
  const r = await enrollSelfDevice(t.db, {
    tenantId,
    userId,
    role: "owner",
    device: { kind: "desktop_agent", platform: "windows", name: "Pat's desktop", clientVersion: "0.1.0" },
  });
  if ("error" in r) throw new Error(r.error);
  return r.device.id;
}

function signal(over: Partial<Parameters<typeof insertDeviceSignal>[1]> = {}) {
  return {
    tenantId: "",
    deviceId: "",
    userId: "",
    clientEventId: randomUUID(),
    type: "software",
    detector: "remote_access_tool",
    subject: "anydesk",
    payload: { toolId: "anydesk", name: "AnyDesk" },
    observedAt: new Date(),
    ...over,
  };
}

describe("signals (PGlite as app_user)", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
    await becomeAppUser(t.client);
  });
  afterAll(async () => {
    await t.close();
  });

  it("inserts a device signal and returns the existing row on a duplicate client_event_id", async () => {
    const { ownerId, tenantId } = await household(t);
    const deviceId = await enrolledDevice(t, tenantId, ownerId);
    const clientEventId = randomUUID();

    const first = await insertDeviceSignal(t.db, signal({ tenantId, deviceId, userId: ownerId, clientEventId }));
    expect(first.duplicate).toBe(false);
    expect(first.row).toMatchObject({ tenantId, deviceId, userId: ownerId, type: "software", detector: "remote_access_tool", outcome: "pending" });

    const again = await insertDeviceSignal(t.db, signal({ tenantId, deviceId, userId: ownerId, clientEventId, subject: "different" }));
    expect(again.duplicate).toBe(true);
    expect(again.row.id).toBe(first.row.id);
    expect(again.row.subject).toBe("anydesk"); // the original row, not the retried payload

    expect(await getDeviceSignal(t.db, tenantId, first.row.id)).toMatchObject({ id: first.row.id });
  });

  it("listDeviceSignalsByClientIds returns only this device's rows among the requested ids", async () => {
    const { ownerId, tenantId } = await household(t);
    const deviceA = await enrolledDevice(t, tenantId, ownerId);
    const deviceB = await enrolledDevice(t, tenantId, ownerId);
    const idA = randomUUID();
    const idB = randomUUID();
    const unknown = randomUUID();
    const { row: rowA } = await insertDeviceSignal(t.db, signal({ tenantId, deviceId: deviceA, userId: ownerId, clientEventId: idA }));
    await insertDeviceSignal(t.db, signal({ tenantId, deviceId: deviceB, userId: ownerId, clientEventId: idB }));

    const results = await listDeviceSignalsByClientIds(t.db, tenantId, deviceA, [idA, idB, unknown]);
    expect(results.map((r) => r.id)).toEqual([rowA.id]);
    expect(await listDeviceSignalsByClientIds(t.db, tenantId, deviceA, [])).toEqual([]);
  });

  it("isolates device_signals and device_expected_tools between households (RLS)", async () => {
    const a = await household(t);
    const deviceA = await enrolledDevice(t, a.tenantId, a.ownerId);
    const b = await household(t);

    const { row } = await insertDeviceSignal(t.db, signal({ tenantId: a.tenantId, deviceId: deviceA, userId: a.ownerId }));
    expect(await getDeviceSignal(t.db, b.tenantId, row.id)).toBeUndefined();
    expect(await listRecentUserSignals(t.db, b.tenantId, a.ownerId, { since: new Date(0) })).toEqual([]);

    await setExpectedTools(t.db, { tenantId: a.tenantId, deviceId: deviceA, tools: [{ toolId: "anydesk", peerIds: [] }], createdBy: a.ownerId });
    expect(await listExpectedTools(t.db, b.tenantId, { deviceId: deviceA })).toEqual([]);
    expect(await listExpectedTools(t.db, a.tenantId, { deviceId: deviceA })).toHaveLength(1);
  });

  it("updates outcome, severity and the linked verdict/alert ids", async () => {
    const { ownerId, tenantId } = await household(t);
    const deviceId = await enrolledDevice(t, tenantId, ownerId);
    const { row } = await insertDeviceSignal(t.db, signal({ tenantId, deviceId, userId: ownerId }));
    expect(row.severity).toBeNull();

    const updated = await updateDeviceSignal(t.db, tenantId, row.id, { severity: "high", outcome: "alerted", verdictId: null, alertId: null });
    expect(updated).toMatchObject({ severity: "high", outcome: "alerted" });
    expect(await updateDeviceSignal(t.db, tenantId, "00000000-0000-4000-8000-000000000000", { outcome: "dismissed" })).toBeUndefined();
  });

  it("lists a member's recent signals oldest first, filtered by since and outcome", async () => {
    const { ownerId, tenantId } = await household(t);
    const deviceId = await enrolledDevice(t, tenantId, ownerId);
    const now = Date.now();
    const older = await insertDeviceSignal(t.db, signal({ tenantId, deviceId, userId: ownerId, observedAt: new Date(now - 2 * 60_000) }));
    const newer = await insertDeviceSignal(t.db, signal({ tenantId, deviceId, userId: ownerId, observedAt: new Date(now - 60_000) }));
    await updateDeviceSignal(t.db, tenantId, newer.row.id, { outcome: "dismissed" });

    const all = await listRecentUserSignals(t.db, tenantId, ownerId, { since: new Date(now - 10 * 60_000) });
    expect(all.map((s) => s.id)).toEqual([older.row.id, newer.row.id]);

    const sinceRecent = await listRecentUserSignals(t.db, tenantId, ownerId, { since: new Date(now - 90_000) });
    expect(sinceRecent.map((s) => s.id)).toEqual([newer.row.id]);

    const pendingOnly = await listRecentUserSignals(t.db, tenantId, ownerId, { since: new Date(now - 10 * 60_000), outcomes: ["pending"] });
    expect(pendingOnly.map((s) => s.id)).toEqual([older.row.id]);
  });

  it("counts a device's signals since a time, optionally escalated only", async () => {
    const { ownerId, tenantId } = await household(t);
    const deviceId = await enrolledDevice(t, tenantId, ownerId);
    const since = new Date(Date.now() - 60_000);
    await insertDeviceSignal(t.db, signal({ tenantId, deviceId, userId: ownerId, escalated: false }));
    await insertDeviceSignal(t.db, signal({ tenantId, deviceId, userId: ownerId, escalated: true }));

    expect(await countDeviceSignalsSince(t.db, tenantId, deviceId, since)).toBe(2);
    expect(await countDeviceSignalsSince(t.db, tenantId, deviceId, since, { escalatedOnly: true })).toBe(1);
    expect(await countDeviceSignalsSince(t.db, tenantId, deviceId, new Date(Date.now() + 60_000))).toBe(0);
  });

  it("replaces a device's expected tools and refuses unknown or revoked devices", async () => {
    const { ownerId, tenantId } = await household(t);
    const deviceId = await enrolledDevice(t, tenantId, ownerId);

    const set1 = await setExpectedTools(t.db, {
      tenantId,
      deviceId,
      tools: [{ toolId: "anydesk", peerIds: ["Grandma-PC"] }],
      createdBy: ownerId,
    });
    expect(set1).toEqual([{ deviceId, toolId: "anydesk", peerIds: ["Grandma-PC"], createdBy: ownerId, createdAt: expect.any(Date) }]);

    // Replacing drops the old set entirely.
    const set2 = await setExpectedTools(t.db, { tenantId, deviceId, tools: [{ toolId: "teamviewer", peerIds: [] }], createdBy: ownerId });
    expect(set2!.map((r) => r.toolId)).toEqual(["teamviewer"]);
    expect(await listExpectedTools(t.db, tenantId, { deviceId })).toHaveLength(1);

    expect(await setExpectedTools(t.db, { tenantId, deviceId: "00000000-0000-4000-8000-000000000000", tools: [], createdBy: ownerId })).toBeUndefined();

    await revokeDevice(t.db, { tenantId, deviceId, revokedBy: ownerId });
    expect(await setExpectedTools(t.db, { tenantId, deviceId, tools: [{ toolId: "anydesk", peerIds: [] }], createdBy: ownerId })).toBeUndefined();
  });

  it("rejects more than 10 peer ids via the check constraint", async () => {
    const { ownerId, tenantId } = await household(t);
    const deviceId = await enrolledDevice(t, tenantId, ownerId);
    const tooMany = Array.from({ length: 11 }, (_, i) => `peer-${i}`);
    await expect(
      setExpectedTools(t.db, { tenantId, deviceId, tools: [{ toolId: "anydesk", peerIds: tooMany }], createdBy: ownerId }),
    ).rejects.toThrow();
  });

  it("purges device_signals older than 30 days by received_at, across tenants", async () => {
    const { ownerId, tenantId } = await household(t);
    const deviceId = await enrolledDevice(t, tenantId, ownerId);
    const { row: fresh } = await insertDeviceSignal(t.db, signal({ tenantId, deviceId, userId: ownerId }));
    const { row: old } = await insertDeviceSignal(t.db, signal({ tenantId, deviceId, userId: ownerId }));
    await tenantScoped(t.db, tenantId).update(deviceSignals, { receivedAt: new Date(Date.now() - 31 * DAY) }, eq(deviceSignals.id, old.id));

    const n = await purgeOldDeviceSignals(t.db);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await getDeviceSignal(t.db, tenantId, old.id)).toBeUndefined();
    expect(await getDeviceSignal(t.db, tenantId, fresh.id)).toMatchObject({ id: fresh.id });
  });

  it("verdicts and alerts checks accept the new signal-related values", async () => {
    const { ownerId, tenantId } = await household(t);
    const [verdictRow] = await tenantScoped(t.db, tenantId).insert(verdicts, {
      userId: ownerId,
      source: "device",
      subjectType: "software",
      verdict: "suspicious",
      confidence: 0.8,
      headline: "AnyDesk was installed",
      body: { subject_type: "software", verdict: "suspicious", confidence: 0.8, headline: "AnyDesk was installed" },
    });
    expect(verdictRow).toMatchObject({ source: "device", subjectType: "software" });

    const alert = await createAlert(t.db, {
      tenantId,
      subjectUserId: ownerId,
      kind: "scam_in_progress",
      severity: "critical",
      title: "Possible scam in progress",
      body: "A scam page was followed by a remote-access install.",
      dedupeKey: `scam_in_progress:${ownerId}:test`,
    });
    expect(alert).toMatchObject({ kind: "scam_in_progress" });
    const [alertRow] = await tenantScoped(t.db, tenantId).select(alerts, eq(alerts.id, alert!.id));
    expect(alertRow?.kind).toBe("scam_in_progress");
  });
});

describe("PostgresReputationCache (PGlite as app_user)", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
    await becomeAppUser(t.client);
  });
  afterAll(async () => {
    await t.close();
  });

  it("gets, sets and expires values, and never throws on a miss", async () => {
    const cache = new PostgresReputationCache(t.db);
    expect(await cache.get("domain:paypa1.test")).toBeUndefined();

    await cache.set("domain:paypa1.test", { verdict: "malicious", source: "safe_browsing" }, 3600);
    expect(await cache.get("domain:paypa1.test")).toEqual({ verdict: "malicious", source: "safe_browsing" });

    // Overwrite.
    await cache.set("domain:paypa1.test", { verdict: "malicious", source: "virustotal" }, 3600);
    expect(await cache.get("domain:paypa1.test")).toEqual({ verdict: "malicious", source: "virustotal" });

    // Backdate expiry directly to simulate a stale row.
    await t.db.update(reputationCache).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(reputationCache.key, "domain:paypa1.test"));
    expect(await cache.get("domain:paypa1.test")).toBeUndefined();
  });

  it("purges expired rows only", async () => {
    const cache = new PostgresReputationCache(t.db);
    await cache.set("hash:fresh", { verdict: "likely_safe" }, 3600);
    await cache.set("hash:stale", { verdict: "likely_safe" }, 3600);
    await t.db.update(reputationCache).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(reputationCache.key, "hash:stale"));

    const n = await purgeExpiredReputationCache(t.db);
    expect(n).toBeGreaterThanOrEqual(1);
    const [remaining] = await t.db.select().from(reputationCache).where(eq(reputationCache.key, "hash:fresh"));
    expect(remaining).toBeDefined();
    const [gone] = await t.db.select().from(reputationCache).where(eq(reputationCache.key, "hash:stale"));
    expect(gone).toBeUndefined();
  });
});
