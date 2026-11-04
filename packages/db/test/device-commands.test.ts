/**
 * Device commands (_specs/v2-m3-cutover.md section 4; migration 0029_device_commands) on PGlite as the
 * non-owner app role: the table is tenant-isolated, one open command per device and tool, expiry, and a
 * command can only be answered by its own device, once.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAlert } from "../src/alerts.js";
import { completeDeviceCommand, createDeviceCommand, DEVICE_COMMAND_TTL_MS, getDeviceCommand, listOpenDeviceCommands, markDeviceCommandsDelivered } from "../src/device-commands.js";
import { recordIncidentAction } from "../src/incident-actions.js";
import { deviceCommands, devices, members } from "../src/schema/index.js";
import { tenantScoped, tenantTables } from "../src/tenant.js";
import { createTenantForUser } from "../src/tenants.js";
import { becomeAppUser, createTestDb, createUser, type TestDb } from "./helpers.js";

let t: TestDb;
let tenantId: string;
let otherTenantId: string;
let ownerId: string;
let deviceA: string;
let deviceB: string;
let otherDevice: string;
let alertId: string;

async function device(tid: string, memberId: string, name: string): Promise<string> {
  const [d] = await tenantScoped(t.db, tid).insert(devices, { userId: null, memberId, kind: "desktop_agent", platform: "windows", name, clientVersion: "1.0.0", enrollment: "code" });
  return d!.id;
}

beforeAll(async () => {
  t = await createTestDb({ createAppUserBeforeMigrations: true });
  ownerId = await createUser(t.db, "Pat");
  tenantId = (await createTenantForUser(t.db, { userId: ownerId, name: "Pat's household" })).tenantId;
  const other = await createUser(t.db, "Zed");
  otherTenantId = (await createTenantForUser(t.db, { userId: other, name: "Zed's household" })).tenantId;
  const [gran] = await tenantScoped(t.db, tenantId).insert(members, { userId: null, displayName: "Gran", role: "elder", mode: "elder" });
  const [zed] = await tenantScoped(t.db, otherTenantId).insert(members, { userId: null, displayName: "Zed kid", role: "child", mode: "child", birthYear: 2015 });
  deviceA = await device(tenantId, gran!.id, "Gran's PC");
  deviceB = await device(tenantId, gran!.id, "Gran's laptop");
  otherDevice = await device(otherTenantId, zed!.id, "Zed's PC");
  const alert = await createAlert(t.db, { tenantId, subjectUserId: null, kind: "remote_access", severity: "critical", title: "Session", body: "A remote session", dedupeKey: "k1", deviceId: deviceA });
  alertId = alert!.id;
  await becomeAppUser(t.client);
}, 60_000);
afterAll(async () => {
  await t?.close();
});

const now = new Date("2026-11-03T12:00:00.000Z");
const input = (over: Partial<Parameters<typeof createDeviceCommand>[2]> = {}) => ({
  deviceId: deviceA,
  alertId,
  kind: "end_session" as const,
  payload: { toolId: "anydesk", peerId: "123 456" },
  requiresConfirmation: true,
  requestedBy: ownerId,
  now,
  ...over,
});

describe("migration 0029_device_commands", () => {
  it("has row-level security with a tenant policy and is in tenantTables", async () => {
    const rls = await t.client.query<{ relrowsecurity: boolean }>(`select relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relname = 'device_commands'`);
    expect(rls.rows[0]?.relrowsecurity).toBe(true);
    const pol = await t.client.query<{ qual: string }>(`select qual from pg_policies where schemaname = 'public' and tablename = 'device_commands' and policyname = 'tenant_isolation'`);
    expect(pol.rows[0]?.qual).toContain("current_setting('app.tenant_id'::text, true)");
    expect(tenantTables.deviceCommands).toBe(deviceCommands);
  });

  it("allows end_session as an incident action and rejects other kinds and statuses", async () => {
    const row = await recordIncidentAction(t.db, tenantId, { alertId, kind: "end_session", requestedBy: "agent", approvedBy: ownerId, status: "pending", result: { commandId: "x" } });
    expect(row.kind).toBe("end_session");
    await expect(tenantScoped(t.db, tenantId).insert(deviceCommands, { deviceId: deviceA, kind: "reboot" as never, payload: { toolId: "x" }, requiresConfirmation: false, expiresAt: now })).rejects.toThrow();
    await expect(tenantScoped(t.db, tenantId).insert(deviceCommands, { deviceId: deviceA, kind: "end_session", status: "maybe" as never, payload: { toolId: "x" }, requiresConfirmation: false, expiresAt: now })).rejects.toThrow();
  });
});

describe("device commands", () => {
  it("creates a pending command that lists until it expires", async () => {
    const { command, existing } = await createDeviceCommand(t.db, tenantId, input());
    expect(existing).toBe(false);
    expect(command).toMatchObject({ status: "pending", kind: "end_session", requiresConfirmation: true, payload: { toolId: "anydesk", peerId: "123 456" }, requestedBy: ownerId });
    expect(command.expiresAt.getTime() - now.getTime()).toBe(DEVICE_COMMAND_TTL_MS);
    expect((await listOpenDeviceCommands(t.db, tenantId, deviceA, now)).map((c) => c.id)).toEqual([command.id]);
    expect(await listOpenDeviceCommands(t.db, tenantId, deviceA, new Date(command.expiresAt.getTime()))).toEqual([]);
    expect(await listOpenDeviceCommands(t.db, tenantId, deviceB, now)).toEqual([]);
  });

  it("returns the open command for the same device and tool instead of queuing a second", async () => {
    const first = (await listOpenDeviceCommands(t.db, tenantId, deviceA, now))[0]!;
    const again = await createDeviceCommand(t.db, tenantId, input({ now: new Date(now.getTime() + 60_000) }));
    expect(again).toMatchObject({ existing: true });
    expect(again.command.id).toBe(first.id);
    // Another tool or another device is a different command.
    expect((await createDeviceCommand(t.db, tenantId, input({ payload: { toolId: "teamviewer" } }))).existing).toBe(false);
    expect((await createDeviceCommand(t.db, tenantId, input({ deviceId: deviceB }))).existing).toBe(false);
  });

  it("expires open commands past their time when a new one is requested", async () => {
    const later = new Date(now.getTime() + DEVICE_COMMAND_TTL_MS + 1000);
    const fresh = await createDeviceCommand(t.db, tenantId, input({ now: later }));
    expect(fresh.existing).toBe(false);
    const rows = await tenantScoped(t.db, tenantId).select(deviceCommands);
    const old = rows.filter((r) => r.deviceId === deviceA && r.payload.toolId === "anydesk" && r.id !== fresh.command.id);
    expect(old.length).toBeGreaterThan(0);
    expect(old.every((r) => r.status === "expired" && r.completedAt)).toBe(true);
  });

  it("marks delivered, and only a pending command", async () => {
    const [open] = await listOpenDeviceCommands(t.db, tenantId, deviceB, now);
    await markDeviceCommandsDelivered(t.db, tenantId, [open!.id, "not-a-uuid"]);
    expect((await getDeviceCommand(t.db, tenantId, open!.id))?.status).toBe("delivered");
    const done = await completeDeviceCommand(t.db, tenantId, { id: open!.id, deviceId: deviceB, status: "done", result: { outcome: "done" }, now });
    expect(done).toMatchObject({ status: "done", result: { outcome: "done" } });
    await markDeviceCommandsDelivered(t.db, tenantId, [open!.id]);
    expect((await getDeviceCommand(t.db, tenantId, open!.id))?.status).toBe("done");
  });

  it("is answered only by its own device, and only once", async () => {
    const { command } = await createDeviceCommand(t.db, tenantId, input({ payload: { toolId: "ultraviewer" } }));
    expect(await completeDeviceCommand(t.db, tenantId, { id: command.id, deviceId: deviceB, status: "done", result: {} })).toBeUndefined();
    expect(await completeDeviceCommand(t.db, tenantId, { id: command.id, deviceId: otherDevice, status: "done", result: {} })).toBeUndefined();
    expect((await getDeviceCommand(t.db, tenantId, command.id))?.status).toBe("pending");
    expect(await completeDeviceCommand(t.db, tenantId, { id: command.id, deviceId: deviceA, status: "declined", result: { outcome: "declined" } })).toMatchObject({ status: "declined" });
    expect(await completeDeviceCommand(t.db, tenantId, { id: command.id, deviceId: deviceA, status: "done", result: {} })).toBeUndefined();
    expect((await getDeviceCommand(t.db, tenantId, command.id))?.status).toBe("declined");
    expect(await listOpenDeviceCommands(t.db, tenantId, deviceA, now)).not.toContainEqual(expect.objectContaining({ id: command.id }));
  });

  it("is invisible and untouchable from another household", async () => {
    const { command } = await createDeviceCommand(t.db, tenantId, input({ payload: { toolId: "supremo" } }));
    expect(await getDeviceCommand(t.db, otherTenantId, command.id)).toBeUndefined();
    expect(await listOpenDeviceCommands(t.db, otherTenantId, deviceA, now)).toEqual([]);
    expect(await completeDeviceCommand(t.db, otherTenantId, { id: command.id, deviceId: deviceA, status: "done", result: {} })).toBeUndefined();
    await expect(createDeviceCommand(t.db, otherTenantId, input({ deviceId: deviceA, alertId: null }))).rejects.toThrow();
    await expect(createDeviceCommand(t.db, tenantId, input({ deviceId: "nope" }))).rejects.toThrow(/invalid device id/);
  });

  it("goes with the device, and keeps the row when the incident is deleted", async () => {
    const { command } = await createDeviceCommand(t.db, tenantId, input({ payload: { toolId: "rustdesk" } }));
    expect(command.alertId).toBe(alertId);
    // Deleted as the table owner (the app role has no tenant context for a bare DELETE), then read again as the app role.
    await t.client.exec("reset role");
    await t.client.query("delete from alerts where id = $1", [alertId]);
    await t.client.exec("set role app_user");
    expect((await getDeviceCommand(t.db, tenantId, command.id))?.alertId).toBeNull();
    await t.client.exec("reset role");
    await t.client.query("delete from devices where id = $1", [deviceA]);
    await t.client.exec("set role app_user");
    expect(await getDeviceCommand(t.db, tenantId, command.id)).toBeUndefined();
  });
});
