/**
 * Devices and enrollment codes (_specs/device-enrollment.md): Postgres via @neo/db
 * when DATABASE_URL is set, else memory-devices.ts. One function per @neo/db
 * function, same arguments minus `db`, plus the wire mappers. Role checks,
 * alerts, emails, audit (beyond what @neo/db writes) and rate limits belong to
 * the callers.
 */
import {
  DEVICE_OFFLINE_AFTER_MS,
  createEnrollmentCode as dbCreateEnrollmentCode,
  enrollSelfDevice as dbEnrollSelfDevice,
  getDevice as dbGetDevice,
  listDevices as dbListDevices,
  listPendingEnrollmentCodes as dbListPendingEnrollmentCodes,
  listStaleDevices as dbListStaleDevices,
  lookupDeviceTenant as dbLookupDeviceTenant,
  markDeviceOfflineAlerted as dbMarkDeviceOfflineAlerted,
  previewEnrollmentCode as dbPreviewEnrollmentCode,
  purgeOldDevices as dbPurgeOldDevices,
  recordHeartbeat as dbRecordHeartbeat,
  redeemEnrollmentCode as dbRedeemEnrollmentCode,
  renameDevice as dbRenameDevice,
  revokeDevice as dbRevokeDevice,
  revokeEnrollmentCode as dbRevokeEnrollmentCode,
  type DeviceInput,
  type DevicePublic,
  type EnrollSelfDeviceResult,
  type EnrollmentCodePreview,
  type EnrollmentCodePublic,
  type MembershipRole,
  type RedeemEnrollmentCodeResult,
} from "@neo/db";
import type { DeviceItem, EnrollmentCodeItem, ExpectedToolItem } from "@/lib/household-types";
import { getDb } from "./db";
import {
  memoryCreateEnrollmentCode,
  memoryEnrollSelfDevice,
  memoryGetDevice,
  memoryListDevices,
  memoryListPendingEnrollmentCodes,
  memoryListStaleDevices,
  memoryLookupDeviceTenant,
  memoryMarkDeviceOfflineAlerted,
  memoryPreviewEnrollmentCode,
  memoryPurgeOldDevices,
  memoryRecordHeartbeat,
  memoryRedeemEnrollmentCode,
  memoryRenameDevice,
  memoryRevokeDevice,
  memoryRevokeEnrollmentCode,
} from "./memory-devices";

export type { DeviceInput, DevicePublic, EnrollmentCodePreview, EnrollmentCodePublic, RedeemEnrollmentCodeResult };

// ─── Wire mappers ──────────────────────────────────────────────────

/**
 * `offline` after DEVICE_OFFLINE_AFTER_MS (48 h) without a heartbeat, counted from
 * `createdAt` when the device never sent one; `never_seen` before the first heartbeat
 * (and not yet offline); else `active`.
 */
export function deviceStatus(d: Pick<DevicePublic, "createdAt" | "lastSeenAt">, now = new Date()): DeviceItem["status"] {
  const last = d.lastSeenAt ?? d.createdAt;
  if (now.getTime() - last.getTime() > DEVICE_OFFLINE_AFTER_MS) return "offline";
  return d.lastSeenAt ? "active" : "never_seen";
}

export function toDeviceItem(d: DevicePublic, now = new Date(), expectedTools: ExpectedToolItem[] = []): DeviceItem {
  return {
    id: d.id,
    userId: d.userId,
    memberName: d.memberName,
    kind: d.kind,
    platform: d.platform,
    name: d.name,
    clientVersion: d.clientVersion,
    enrollment: d.enrollment,
    enrolledByName: d.enrolledByName,
    createdAt: d.createdAt.toISOString(),
    lastSeenAt: d.lastSeenAt ? d.lastSeenAt.toISOString() : null,
    status: deviceStatus(d, now),
    expectedTools,
  };
}

export function toEnrollmentCodeItem(c: EnrollmentCodePublic): EnrollmentCodeItem {
  return {
    id: c.id,
    userId: c.userId,
    memberName: c.memberName,
    createdAt: c.createdAt.toISOString(),
    expiresAt: c.expiresAt.toISOString(),
  };
}

// ─── Enrollment codes ──────────────────────────────────────────────

export async function createEnrollmentCode(input: {
  tenantId: string;
  userId: string;
  createdBy: string;
  now?: Date;
}): Promise<{ code: string; record: EnrollmentCodePublic } | { error: "not_member" | "code_limit" | "device_limit" }> {
  const db = getDb();
  return db ? dbCreateEnrollmentCode(db, input) : memoryCreateEnrollmentCode(input);
}

export async function listPendingEnrollmentCodes(tenantId: string, now?: Date): Promise<EnrollmentCodePublic[]> {
  const db = getDb();
  return db ? dbListPendingEnrollmentCodes(db, tenantId, now) : memoryListPendingEnrollmentCodes(tenantId, now);
}

export async function revokeEnrollmentCode(tenantId: string, id: string, now?: Date): Promise<boolean> {
  const db = getDb();
  return db ? dbRevokeEnrollmentCode(db, tenantId, id, now) : memoryRevokeEnrollmentCode(tenantId, id, now);
}

export async function previewEnrollmentCode(input: { code: string; now?: Date }): Promise<EnrollmentCodePreview | null> {
  const db = getDb();
  return db ? dbPreviewEnrollmentCode(db, input) : memoryPreviewEnrollmentCode(input);
}

export async function redeemEnrollmentCode(input: { code: string; device: DeviceInput; now?: Date }): Promise<RedeemEnrollmentCodeResult> {
  const db = getDb();
  return db ? dbRedeemEnrollmentCode(db, input) : memoryRedeemEnrollmentCode(input);
}

export async function enrollSelfDevice(input: {
  tenantId: string;
  userId: string;
  role: MembershipRole;
  device: DeviceInput;
  now?: Date;
}): Promise<EnrollSelfDeviceResult> {
  const db = getDb();
  return db ? dbEnrollSelfDevice(db, input) : memoryEnrollSelfDevice(input);
}

// ─── Devices ───────────────────────────────────────────────────────

/** Active devices, newest first; `userId` restricts to one member's devices. */
export async function listDevices(tenantId: string, opts: { userId?: string } = {}): Promise<DevicePublic[]> {
  const db = getDb();
  return db ? dbListDevices(db, tenantId, opts) : memoryListDevices(tenantId, opts);
}

/** One device, including revoked ones. */
export async function getDevice(tenantId: string, id: string): Promise<DevicePublic | undefined> {
  const db = getDb();
  return db ? dbGetDevice(db, tenantId, id) : memoryGetDevice(tenantId, id);
}

/** The tenant of an active device, known only by its id (the unauthenticated uninstall route). */
export async function lookupDeviceTenant(id: string): Promise<string | undefined> {
  const db = getDb();
  return db ? dbLookupDeviceTenant(db, id) : memoryLookupDeviceTenant(id);
}

export async function renameDevice(tenantId: string, id: string, name: string): Promise<DevicePublic | "invalid" | undefined> {
  const db = getDb();
  return db ? dbRenameDevice(db, tenantId, id, name) : memoryRenameDevice(tenantId, id, name);
}

/** Revoke a device and its tokens. Idempotent (`alreadyRevoked`); undefined for unknown ids. */
export async function revokeDevice(input: {
  tenantId: string;
  deviceId: string;
  revokedBy: string | null;
  now?: Date;
}): Promise<{ device: DevicePublic; alreadyRevoked: boolean } | undefined> {
  const db = getDb();
  return db ? dbRevokeDevice(db, input) : memoryRevokeDevice(input);
}

export async function recordHeartbeat(input: {
  tenantId: string;
  deviceId: string;
  clientVersion?: string;
  now?: Date;
}): Promise<DevicePublic | undefined> {
  const db = getDb();
  return db ? dbRecordHeartbeat(db, input) : memoryRecordHeartbeat(input);
}

// ─── Jobs ──────────────────────────────────────────────────────────

export async function listStaleDevices(before: Date): Promise<{ id: string; tenantId: string }[]> {
  const db = getDb();
  return db ? dbListStaleDevices(db, before) : memoryListStaleDevices(before);
}

export async function markDeviceOfflineAlerted(tenantId: string, deviceId: string, at: Date): Promise<DevicePublic | undefined> {
  const db = getDb();
  return db ? dbMarkDeviceOfflineAlerted(db, tenantId, deviceId, at) : memoryMarkDeviceOfflineAlerted(tenantId, deviceId, at);
}

export async function purgeOldDevices(): Promise<number> {
  const db = getDb();
  return db ? dbPurgeOldDevices(db) : memoryPurgeOldDevices();
}
