/**
 * The command expiry sweep (migration 0029: list_expired_device_commands / expire_device_commands) as the
 * non-owner app role: it works across households, reads without writing, expires only open commands past
 * their time, and the pending end_session action of an expired command is settled once.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAlert } from "../src/alerts.js";
import { completeDeviceCommand, createDeviceCommand, DEVICE_COMMAND_TTL_MS, expireDeviceCommands, failExpiredCommandAction, getDeviceCommand, listExpiredDeviceCommands } from "../src/device-commands.js";
import { listIncidentActions, recordIncidentAction } from "../src/incident-actions.js";
import { devices, members } from "../src/schema/index.js";
import { tenantScoped } from "../src/tenant.js";
import { createTenantForUser } from "../src/tenants.js";
import { becomeAppUser, createTestDb, createUser, type TestDb } from "./helpers.js";

let t: TestDb;
const households: { tenantId: string; userId: string; deviceId: string; alertId: string }[] = [];

beforeAll(async () => {
  t = await createTestDb({ createAppUserBeforeMigrations: true });
  for (const name of ["Pat", "Zed"]) {
    const userId = await createUser(t.db, name);
    const tenantId = (await createTenantForUser(t.db, { userId, name: `${name}'s household` })).tenantId;
    const [m] = await tenantScoped(t.db, tenantId).insert(members, { userId: null, displayName: "Gran", role: "elder", mode: "elder" });
    const [d] = await tenantScoped(t.db, tenantId).insert(devices, { userId: null, memberId: m!.id, kind: "desktop_agent", platform: "windows", name: "PC", clientVersion: "1.0.0", enrollment: "code" });
    const alert = await createAlert(t.db, { tenantId, subjectUserId: null, kind: "remote_access", severity: "critical", title: "Session", body: "x", dedupeKey: `k-${name}`, deviceId: d!.id });
    households.push({ tenantId, userId, deviceId: d!.id, alertId: alert!.id });
  }
  await becomeAppUser(t.client);
}, 60_000);
afterAll(async () => {
  await t?.close();
});

const start = new Date("2026-11-03T12:00:00.000Z");
const after = new Date(start.getTime() + DEVICE_COMMAND_TTL_MS + 1);

async function request(i: number, toolId: string) {
  const h = households[i]!;
  const { command } = await createDeviceCommand(t.db, h.tenantId, { deviceId: h.deviceId, alertId: h.alertId, kind: "end_session", payload: { toolId }, requiresConfirmation: true, requestedBy: h.userId, now: start });
  await recordIncidentAction(t.db, h.tenantId, { alertId: h.alertId, kind: "end_session", requestedBy: "agent", approvedBy: h.userId, status: "pending", result: { commandId: command.id, toolId } });
  return command;
}

describe("the expiry sweep", () => {
  it("lists expired open commands across households without changing anything", async () => {
    const a = await request(0, "anydesk");
    const b = await request(1, "anydesk");
    expect(await listExpiredDeviceCommands(t.db, start)).toEqual([]);
    expect(await listExpiredDeviceCommands(t.db, after)).toEqual(expect.arrayContaining([{ id: a.id, tenantId: households[0]!.tenantId }, { id: b.id, tenantId: households[1]!.tenantId }]));
    expect((await getDeviceCommand(t.db, households[0]!.tenantId, a.id))?.status).toBe("pending");
  });

  it("expires them, once, and leaves finished and unexpired commands alone", async () => {
    const done = await request(0, "teamviewer");
    await completeDeviceCommand(t.db, households[0]!.tenantId, { id: done.id, deviceId: households[0]!.deviceId, status: "done", result: { outcome: "done" }, now: start });
    const expired = await expireDeviceCommands(t.db, after);
    const fresh = await createDeviceCommand(t.db, households[1]!.tenantId, { deviceId: households[1]!.deviceId, alertId: null, kind: "end_session", payload: { toolId: "ultraviewer" }, requiresConfirmation: false, requestedBy: null, now: new Date(after.getTime() + 60_000) });
    expect(expired).toHaveLength(2);
    expect(expired.map((e) => e.tenantId).sort()).toEqual(households.map((h) => h.tenantId).sort());
    expect(expired.every((e) => e.alertId)).toBe(true);
    const row = await getDeviceCommand(t.db, households[0]!.tenantId, expired.find((e) => e.tenantId === households[0]!.tenantId)!.id);
    expect(row).toMatchObject({ status: "expired", result: { outcome: "expired", reason: "no_response" } });
    expect(row?.completedAt?.getTime()).toBe(after.getTime());
    expect((await getDeviceCommand(t.db, households[0]!.tenantId, done.id))?.status).toBe("done");
    expect((await getDeviceCommand(t.db, households[1]!.tenantId, fresh.command.id))?.status).toBe("pending");
    expect(await expireDeviceCommands(t.db, after)).toEqual([]);
  });

  it("settles the pending end_session action as failed with reason expired, once, and only in its household", async () => {
    const h = households[0]!;
    const pending = (await listIncidentActions(t.db, h.tenantId, h.alertId)).filter((a) => a.status === "pending");
    expect(pending.length).toBeGreaterThan(0);
    const commandId = (pending[0]!.result as { commandId: string }).commandId;
    expect(await failExpiredCommandAction(t.db, households[1]!.tenantId, { alertId: h.alertId, commandId, now: after })).toBe(false);
    expect(await failExpiredCommandAction(t.db, h.tenantId, { alertId: h.alertId, commandId, now: after })).toBe(true);
    const row = (await listIncidentActions(t.db, h.tenantId, h.alertId)).find((a) => (a.result as { commandId?: string }).commandId === commandId)!;
    expect(row).toMatchObject({ status: "failed", result: { commandId, toolId: expect.any(String), reason: "expired" } });
    expect(await failExpiredCommandAction(t.db, h.tenantId, { alertId: h.alertId, commandId, now: after })).toBe(false);
    expect(await failExpiredCommandAction(t.db, h.tenantId, { alertId: "nope", commandId, now: after })).toBe(false);
  });
});
