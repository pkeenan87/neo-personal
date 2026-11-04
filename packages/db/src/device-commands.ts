/**
 * Commands the server sends to a device (_specs/v2-m3-cutover.md section 4; migration 0029). Tenant-scoped.
 * A command is `pending` until the device fetches it in its policy bundle (`delivered`), then ends in
 * `done`, `declined`, `failed` or `expired`. Nothing here decides whether a command may be created: the
 * caller (the `end_session` tool) has already checked the owner, the device and the incident.
 */
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { alerts, deviceCommands, devices, type DeviceCommandKind, type DeviceCommandPayload, type DeviceCommandStatus } from "./schema/index.js";
import { assertTenantId, tenantScoped } from "./tenant.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A command is acted on for this long after it was requested. */
export const DEVICE_COMMAND_TTL_MS = 10 * 60 * 1000;

export type DeviceCommandRow = typeof deviceCommands.$inferSelect;

/** Statuses a device can still answer. */
const OPEN: DeviceCommandStatus[] = ["pending", "delivered"];

export interface CreateDeviceCommandInput {
  deviceId: string;
  alertId: string | null;
  kind: DeviceCommandKind;
  payload: DeviceCommandPayload;
  requiresConfirmation: boolean;
  requestedBy: string | null;
  now?: Date;
}

/**
 * Create a command, or return the one already open for the same device, kind and tool (`existing: true`),
 * so a repeated request never queues two. Open commands past their expiry are first marked `expired`.
 * A device that is not in this household fails the foreign key or the row-level security check.
 */
export async function createDeviceCommand(db: Db, tenantId: string, input: CreateDeviceCommandInput): Promise<{ command: DeviceCommandRow; existing: boolean }> {
  assertTenantId(tenantId);
  if (!UUID_RE.test(input.deviceId)) throw new Error("@neo/db: invalid device id");
  const now = input.now ?? new Date();
  return tenantScoped(db, tenantId).transaction(async (t) => {
    // The foreign keys alone would accept another household's device or alert.
    if (!(await t.first(devices, eq(devices.id, input.deviceId)))) throw new Error("@neo/db: device not found in this household");
    if (input.alertId && !(await t.first(alerts, eq(alerts.id, input.alertId)))) throw new Error("@neo/db: alert not found in this household");
    await t.update(
      deviceCommands,
      { status: "expired", completedAt: now },
      and(eq(deviceCommands.deviceId, input.deviceId), inArray(deviceCommands.status, OPEN), lte(deviceCommands.expiresAt, now)),
    );
    const open = await t.select(
      deviceCommands,
      and(eq(deviceCommands.deviceId, input.deviceId), eq(deviceCommands.kind, input.kind), inArray(deviceCommands.status, OPEN), sql`${deviceCommands.payload}->>'toolId' = ${input.payload.toolId}`),
    );
    if (open[0]) return { command: open[0], existing: true };
    const [row] = await t.insert(deviceCommands, {
      deviceId: input.deviceId,
      alertId: input.alertId,
      kind: input.kind,
      payload: input.payload,
      requiresConfirmation: input.requiresConfirmation,
      requestedBy: input.requestedBy,
      createdAt: now,
      expiresAt: new Date(now.getTime() + DEVICE_COMMAND_TTL_MS),
    });
    if (!row) throw new Error("@neo/db: device command insert returned no row");
    return { command: row, existing: false };
  });
}

/** The device's open commands that have not expired as of `now`, oldest first. */
export async function listOpenDeviceCommands(db: Db, tenantId: string, deviceId: string, now = new Date()): Promise<DeviceCommandRow[]> {
  assertTenantId(tenantId);
  if (!UUID_RE.test(deviceId)) return [];
  const rows = await tenantScoped(db, tenantId).select(deviceCommands, and(eq(deviceCommands.deviceId, deviceId), inArray(deviceCommands.status, OPEN)), { orderBy: [sql`${deviceCommands.createdAt} asc`] });
  return rows.filter((r) => r.expiresAt.getTime() > now.getTime());
}

/** One command of the household, or undefined. */
export async function getDeviceCommand(db: Db, tenantId: string, id: string): Promise<DeviceCommandRow | undefined> {
  assertTenantId(tenantId);
  if (!UUID_RE.test(id)) return undefined;
  return tenantScoped(db, tenantId).first(deviceCommands, eq(deviceCommands.id, id));
}

/** `pending` to `delivered` for these ids (the device has fetched them). Other statuses are left alone. */
export async function markDeviceCommandsDelivered(db: Db, tenantId: string, ids: readonly string[]): Promise<void> {
  assertTenantId(tenantId);
  const valid = ids.filter((id) => UUID_RE.test(id));
  if (valid.length === 0) return;
  await tenantScoped(db, tenantId).update(deviceCommands, { status: "delivered" }, and(inArray(deviceCommands.id, valid), eq(deviceCommands.status, "pending")));
}

/**
 * Close an open command with the device's answer. Atomic on the status, so a repeated or racing answer
 * changes nothing; undefined for an unknown id, another device's command, or one already finished.
 */
export async function completeDeviceCommand(
  db: Db,
  tenantId: string,
  input: { id: string; deviceId: string; status: Extract<DeviceCommandStatus, "done" | "declined" | "failed" | "expired">; result: Record<string, unknown>; now?: Date },
): Promise<DeviceCommandRow | undefined> {
  assertTenantId(tenantId);
  if (!UUID_RE.test(input.id) || !UUID_RE.test(input.deviceId)) return undefined;
  const [row] = await tenantScoped(db, tenantId).update(
    deviceCommands,
    { status: input.status, result: input.result, completedAt: input.now ?? new Date() },
    and(eq(deviceCommands.id, input.id), eq(deviceCommands.deviceId, input.deviceId), inArray(deviceCommands.status, OPEN)),
  );
  return row;
}
