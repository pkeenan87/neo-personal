/**
 * Monitored devices, enrollment codes and device tokens (_specs/device-enrollment.md).
 *
 *   create / list / revoke codes      owner, inside the household's tenant context
 *   preview / redeem code             unauthenticated client holding the code
 *   enrollSelfDevice                  device authorization redemption (desktop-auth.ts)
 *   list / get / rename / revoke      household settings
 *   heartbeat                         the device itself (scope `device`)
 *   stale / offline / purge           jobs; cross-tenant scans go through security-definer functions
 *
 * Every tenant-table query runs with app.tenant_id set (tenantScoped() or setTenantContext)
 * and filters on tenant_id. Only the SHA-256 of an enrollment code is stored.
 */
import { createHash } from "node:crypto";
import { and, count, desc, eq, gt, isNull, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db, Tx } from "./client.js";
import { insertDeviceToken, type DesktopTokenPublic } from "./desktop-tokens.js";
import {
  auditEvents,
  deviceEnrollmentCodes,
  devices,
  desktopTokens,
  memberships,
  tenants,
  users,
  DEVICE_KINDS,
  DEVICE_PLATFORMS,
  MONITORING_SCOPES,
  type DeviceEnrollment,
  type DeviceKind,
  type DevicePlatform,
  type MembershipRole,
} from "./schema/index.js";
import { assertTenantId, setTenantContext, tenantScoped } from "./tenant.js";
import { USER_CODE_ALPHABET, groupCode, randomGroupedCode } from "./user-codes.js";

export const MAX_DEVICES_PER_HOUSEHOLD = 20;
export const MAX_PENDING_ENROLLMENT_CODES = 10;
export const ENROLLMENT_CODE_TTL_MS = 24 * 60 * 60 * 1000;
export const DEVICE_OFFLINE_AFTER_MS = 48 * 60 * 60 * 1000;
export const MAX_DEVICE_NAME = 64;
export const MAX_DEVICE_CLIENT_VERSION = 32;
const ENROLLMENT_CODE_LENGTH = 12;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DeviceInput {
  kind: DeviceKind;
  platform: DevicePlatform;
  name: string;
  clientVersion: string;
}

export interface DevicePublic {
  id: string;
  tenantId: string;
  userId: string;
  memberName: string | null;
  kind: DeviceKind;
  platform: DevicePlatform;
  name: string;
  clientVersion: string;
  enrollment: DeviceEnrollment;
  enrolledBy: string | null;
  enrolledByName: string | null;
  createdAt: Date;
  lastSeenAt: Date | null;
  offlineAlertedAt: Date | null;
  revokedAt: Date | null;
}

export interface EnrollmentCodePublic {
  id: string;
  userId: string;
  memberName: string | null;
  createdBy: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface EnrollmentCodePreview {
  householdName: string;
  memberName: string | null;
  ownerName: string | null;
  expiresAt: Date;
}

export type RedeemEnrollmentCodeResult =
  | {
      status: "enrolled";
      token: string;
      tokenId: string;
      device: DevicePublic;
      householdName: string;
      memberName: string | null;
      createdBy: string | null;
    }
  | { status: "not_found" | "device_limit" | "invalid" };

export type EnrollSelfDeviceResult =
  | { token: string; tokenId: string; record: DesktopTokenPublic; device: DevicePublic }
  | { error: "device_limit" | "invalid" | "not_member" };

// ─── Codes and input ───────────────────────────────────────────────

/** `XXXX-XXXX-XXXX` from the device-flow alphabet (≈ 56 bits). Shown once; stored hashed. */
export function mintEnrollmentCode(): string {
  return randomGroupedCode(ENROLLMENT_CODE_LENGTH);
}

/** Case-insensitive, with or without dashes or spaces; null when it cannot be a code. */
export function normalizeEnrollmentCode(input: string): string | null {
  if (typeof input !== "string") return null;
  const raw = input.toUpperCase().replace(/[\s-]/g, "");
  if (raw.length !== ENROLLMENT_CODE_LENGTH) return null;
  for (const ch of raw) if (!USER_CODE_ALPHABET.includes(ch)) return null;
  return groupCode(raw);
}

/** SHA-256 hex of the canonical form (callers may pass a typed code). */
export function hashEnrollmentCode(code: string): string {
  return createHash("sha256")
    .update(normalizeEnrollmentCode(code) ?? code, "utf8")
    .digest("hex");
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** Control characters to spaces, whitespace collapsed and trimmed; null unless 1–64 characters. */
export function normalizeDeviceName(s: string): string | null {
  if (typeof s !== "string") return null;
  const cleaned = s.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  const len = [...cleaned].length;
  if (len < 1 || len > MAX_DEVICE_NAME) return null;
  return cleaned;
}

function normalizeClientVersion(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const v = s.trim();
  const len = [...v].length;
  if (len < 1 || len > MAX_DEVICE_CLIENT_VERSION || new RegExp(CONTROL_CHARS.source).test(v)) return null;
  return v;
}

/** Validated, normalized device input; null for an unknown kind or platform, bad name or version. */
export function normalizeDeviceInput(input: unknown): DeviceInput | null {
  if (!input || typeof input !== "object") return null;
  const d = input as Record<string, unknown>;
  if (!(DEVICE_KINDS as readonly unknown[]).includes(d.kind)) return null;
  if (!(DEVICE_PLATFORMS as readonly unknown[]).includes(d.platform)) return null;
  const name = normalizeDeviceName(d.name as string);
  const clientVersion = normalizeClientVersion(d.clientVersion);
  if (!name || !clientVersion) return null;
  return { kind: d.kind as DeviceKind, platform: d.platform as DevicePlatform, name, clientVersion };
}

// ─── Helpers ───────────────────────────────────────────────────────

/** Serializes cap checks (codes, devices) within one household. */
async function lockDevices(tx: Tx, tenantId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"neo:devices:" + tenantId}, 0))`);
}

function pendingCodeWhere(now: Date): SQL {
  return and(
    isNull(deviceEnrollmentCodes.redeemedAt),
    isNull(deviceEnrollmentCodes.revokedAt),
    gt(deviceEnrollmentCodes.expiresAt, now),
  ) as SQL;
}

async function lookupCode(tx: Tx, code: string): Promise<{ id: string; tenantId: string } | undefined> {
  const res = await tx.execute(sql`select id, tenant_id from lookup_device_enrollment_code(${hashEnrollmentCode(code)})`);
  const [r] = (res as unknown as { rows: Array<{ id: string; tenant_id: string }> }).rows;
  return r ? { id: r.id, tenantId: r.tenant_id } : undefined;
}

const member = alias(users, "member");
const enroller = alias(users, "enroller");

/** Devices with member and enroller names. `tx` must have app.tenant_id = tenantId. */
async function selectDevices(tx: Tx, tenantId: string, where?: SQL, limit?: number): Promise<DevicePublic[]> {
  const q = tx
    .select({ row: devices, memberName: member.name, enrolledByName: enroller.name })
    .from(devices)
    .leftJoin(member, eq(member.id, devices.userId))
    .leftJoin(enroller, eq(enroller.id, devices.enrolledBy))
    .where(where ? and(eq(devices.tenantId, tenantId), where) : eq(devices.tenantId, tenantId))
    .orderBy(desc(devices.createdAt), desc(devices.id))
    .$dynamic();
  if (limit !== undefined) q.limit(limit);
  const rows = await q;
  return rows.map(({ row, memberName, enrolledByName }) => ({
    id: row.id,
    tenantId: row.tenantId,
    userId: row.userId,
    memberName,
    kind: row.kind,
    platform: row.platform,
    name: row.name,
    clientVersion: row.clientVersion,
    enrollment: row.enrollment,
    enrolledBy: row.enrolledBy,
    enrolledByName,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    offlineAlertedAt: row.offlineAlertedAt,
    revokedAt: row.revokedAt,
  }));
}

async function deviceById(tx: Tx, tenantId: string, id: string): Promise<DevicePublic | undefined> {
  return (await selectDevices(tx, tenantId, eq(devices.id, id), 1))[0];
}

async function activeDeviceCount(tx: Tx, tenantId: string): Promise<number> {
  const [r] = await tx
    .select({ n: count() })
    .from(devices)
    .where(and(eq(devices.tenantId, tenantId), isNull(devices.revokedAt)));
  return r?.n ?? 0;
}

async function membershipOf(tx: Tx, tenantId: string, userId: string): Promise<{ role: MembershipRole } | undefined> {
  const [m] = await tx
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)))
    .limit(1);
  return m;
}

async function userName(tx: Tx, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const [u] = await tx.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
  return u?.name ?? null;
}

/**
 * Insert an active device and its monitoring token, and audit `device.enrolled`.
 * Caller holds lockDevices and has checked membership and input. Null at the device cap.
 */
async function insertDevice(
  tx: Tx,
  input: {
    tenantId: string;
    userId: string;
    role: MembershipRole;
    device: DeviceInput;
    enrollment: DeviceEnrollment;
    enrolledBy: string | null;
    now: Date;
  },
): Promise<{ token: string; record: DesktopTokenPublic; device: DevicePublic } | null> {
  if ((await activeDeviceCount(tx, input.tenantId)) >= MAX_DEVICES_PER_HOUSEHOLD) return null;
  const [row] = await tx
    .insert(devices)
    .values({
      tenantId: input.tenantId,
      userId: input.userId,
      kind: input.device.kind,
      platform: input.device.platform,
      name: input.device.name,
      clientVersion: input.device.clientVersion,
      enrollment: input.enrollment,
      enrolledBy: input.enrolledBy,
      createdAt: input.now,
    })
    .returning({ id: devices.id });
  if (!row) throw new Error("@neo/db: device insert returned no row");
  const minted = await insertDeviceToken(tx, {
    userId: input.userId,
    tenantId: input.tenantId,
    role: input.role,
    name: input.device.name,
    deviceId: row.id,
    scopes: MONITORING_SCOPES,
  });
  await tx.insert(auditEvents).values({
    tenantId: input.tenantId,
    userId: input.enrolledBy,
    eventType: "device.enrolled",
    metadata: { deviceId: row.id, userId: input.userId, enrollment: input.enrollment },
  });
  const device = await deviceById(tx, input.tenantId, row.id);
  if (!device) throw new Error("@neo/db: inserted device not readable");
  return { ...minted, device };
}

// ─── Owner: enrollment codes ───────────────────────────────────────

export async function createEnrollmentCode(
  db: Db,
  input: { tenantId: string; userId: string; createdBy: string; now?: Date },
): Promise<{ code: string; record: EnrollmentCodePublic } | { error: "not_member" | "code_limit" | "device_limit" }> {
  const now = input.now ?? new Date();
  return tenantScoped(db, input.tenantId).transaction(async (t) => {
    await lockDevices(t.tx, input.tenantId);
    if (!(await membershipOf(t.tx, input.tenantId, input.userId))) return { error: "not_member" as const };
    if ((await t.count(deviceEnrollmentCodes, pendingCodeWhere(now))) >= MAX_PENDING_ENROLLMENT_CODES) {
      return { error: "code_limit" as const };
    }
    if ((await activeDeviceCount(t.tx, input.tenantId)) >= MAX_DEVICES_PER_HOUSEHOLD) return { error: "device_limit" as const };
    const code = mintEnrollmentCode();
    const [row] = await t.insert(deviceEnrollmentCodes, {
      userId: input.userId,
      codeHash: hashEnrollmentCode(code),
      createdBy: input.createdBy,
      createdAt: now,
      expiresAt: new Date(now.getTime() + ENROLLMENT_CODE_TTL_MS),
    });
    if (!row) throw new Error("@neo/db: enrollment code insert returned no row");
    return {
      code,
      record: {
        id: row.id,
        userId: row.userId,
        memberName: await userName(t.tx, row.userId),
        createdBy: row.createdBy,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
      },
    };
  });
}

/** Pending (unredeemed, unrevoked, unexpired) codes, newest first. */
export async function listPendingEnrollmentCodes(db: Db, tenantId: string, now = new Date()): Promise<EnrollmentCodePublic[]> {
  return tenantScoped(db, tenantId).transaction((t) =>
    t.tx
      .select({
        id: deviceEnrollmentCodes.id,
        userId: deviceEnrollmentCodes.userId,
        memberName: users.name,
        createdBy: deviceEnrollmentCodes.createdBy,
        createdAt: deviceEnrollmentCodes.createdAt,
        expiresAt: deviceEnrollmentCodes.expiresAt,
      })
      .from(deviceEnrollmentCodes)
      .leftJoin(users, eq(users.id, deviceEnrollmentCodes.userId))
      .where(and(eq(deviceEnrollmentCodes.tenantId, tenantId), pendingCodeWhere(now)))
      .orderBy(desc(deviceEnrollmentCodes.createdAt)),
  );
}

/** Cancel a code. True when the code exists (including already revoked or used); false for unknown ids. */
export async function revokeEnrollmentCode(db: Db, tenantId: string, id: string, now = new Date()): Promise<boolean> {
  if (!UUID_RE.test(id)) return false;
  return tenantScoped(db, tenantId).transaction(async (t) => {
    const row = await t.first(deviceEnrollmentCodes, eq(deviceEnrollmentCodes.id, id));
    if (!row) return false;
    await t.update(
      deviceEnrollmentCodes,
      { revokedAt: now },
      and(eq(deviceEnrollmentCodes.id, id), isNull(deviceEnrollmentCodes.revokedAt), isNull(deviceEnrollmentCodes.redeemedAt)),
    );
    return true;
  });
}

// ─── Client: preview and redeem ────────────────────────────────────

/** What the client shows before asking for consent. Null for unknown, expired, revoked or used codes. */
export async function previewEnrollmentCode(db: Db, input: { code: string; now?: Date }): Promise<EnrollmentCodePreview | null> {
  const code = normalizeEnrollmentCode(input.code);
  if (!code) return null;
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const ids = await lookupCode(tx, code);
    if (!ids) return null;
    await setTenantContext(tx, ids.tenantId);
    const [row] = await tx
      .select({ code: deviceEnrollmentCodes, householdName: tenants.name, memberName: users.name })
      .from(deviceEnrollmentCodes)
      .innerJoin(tenants, eq(tenants.id, deviceEnrollmentCodes.tenantId))
      .leftJoin(users, eq(users.id, deviceEnrollmentCodes.userId))
      .where(and(eq(deviceEnrollmentCodes.tenantId, ids.tenantId), eq(deviceEnrollmentCodes.id, ids.id)))
      .limit(1);
    if (!row || row.code.redeemedAt || row.code.revokedAt || row.code.expiresAt.getTime() <= now.getTime()) return null;
    if (!(await membershipOf(tx, ids.tenantId, row.code.userId))) return null;
    const [owner] = await tx
      .select({ name: users.name })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.tenantId, ids.tenantId), eq(memberships.role, "owner")))
      .orderBy(memberships.createdAt)
      .limit(1);
    return {
      householdName: row.householdName,
      memberName: row.memberName,
      ownerName: owner?.name ?? null,
      expiresAt: row.code.expiresAt,
    };
  });
}

/**
 * Redeem a code in one transaction: lock it FOR UPDATE, re-check it is pending and the
 * member still belongs to the household, insert the device (`code`, enrolled by the
 * code's creator), mint a MONITORING_SCOPES token for the member, mark the code redeemed.
 */
export async function redeemEnrollmentCode(
  db: Db,
  input: { code: string; device: DeviceInput; now?: Date },
): Promise<RedeemEnrollmentCodeResult> {
  const device = normalizeDeviceInput(input.device);
  if (!device) return { status: "invalid" };
  const code = normalizeEnrollmentCode(input.code);
  if (!code) return { status: "not_found" };
  const now = input.now ?? new Date();
  return db.transaction(async (tx): Promise<RedeemEnrollmentCodeResult> => {
    const ids = await lookupCode(tx, code);
    if (!ids) return { status: "not_found" };
    await setTenantContext(tx, ids.tenantId);
    const [row] = await tx
      .select()
      .from(deviceEnrollmentCodes)
      .where(and(eq(deviceEnrollmentCodes.tenantId, ids.tenantId), eq(deviceEnrollmentCodes.id, ids.id)))
      .limit(1)
      .for("update");
    if (!row || row.redeemedAt || row.revokedAt || row.expiresAt.getTime() <= now.getTime()) return { status: "not_found" };
    await lockDevices(tx, ids.tenantId);
    const membership = await membershipOf(tx, ids.tenantId, row.userId);
    if (!membership) return { status: "not_found" };

    const enrolled = await insertDevice(tx, {
      tenantId: ids.tenantId,
      userId: row.userId,
      role: membership.role,
      device,
      enrollment: "code",
      enrolledBy: row.createdBy,
      now,
    });
    if (!enrolled) return { status: "device_limit" };
    await tx
      .update(deviceEnrollmentCodes)
      .set({ redeemedAt: now, deviceId: enrolled.device.id })
      .where(and(eq(deviceEnrollmentCodes.tenantId, ids.tenantId), eq(deviceEnrollmentCodes.id, row.id)));
    const [tenant] = await tx.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, ids.tenantId)).limit(1);
    return {
      status: "enrolled",
      token: enrolled.token,
      tokenId: enrolled.record.id,
      device: enrolled.device,
      householdName: tenant?.name ?? "Household",
      memberName: enrolled.device.memberName,
      createdBy: row.createdBy,
    };
  });
}

/**
 * Self-enrollment through device authorization: the member enrolls their own device
 * (`self`, enrolled by themselves). The role comes from the member's current membership;
 * `role` is the caller's snapshot and is used only if they match.
 */
export async function enrollSelfDevice(
  db: Db,
  input: { tenantId: string; userId: string; role: MembershipRole; device: DeviceInput; now?: Date },
): Promise<EnrollSelfDeviceResult> {
  const device = normalizeDeviceInput(input.device);
  if (!device) return { error: "invalid" };
  const now = input.now ?? new Date();
  return tenantScoped(db, input.tenantId).transaction(async (t): Promise<EnrollSelfDeviceResult> => {
    await lockDevices(t.tx, input.tenantId);
    const membership = await membershipOf(t.tx, input.tenantId, input.userId);
    if (!membership) return { error: "not_member" };
    const enrolled = await insertDevice(t.tx, {
      tenantId: input.tenantId,
      userId: input.userId,
      role: membership.role,
      device,
      enrollment: "self",
      enrolledBy: input.userId,
      now,
    });
    if (!enrolled) return { error: "device_limit" };
    return { token: enrolled.token, tokenId: enrolled.record.id, record: enrolled.record, device: enrolled.device };
  });
}

// ─── Household: devices ────────────────────────────────────────────

/** Active devices, newest first; `userId` restricts to one member's devices. */
export async function listDevices(db: Db, tenantId: string, opts: { userId?: string } = {}): Promise<DevicePublic[]> {
  const conds: SQL[] = [isNull(devices.revokedAt)];
  if (opts.userId !== undefined) conds.push(eq(devices.userId, opts.userId));
  return tenantScoped(db, tenantId).transaction((t) => selectDevices(t.tx, tenantId, and(...conds)));
}

/** One device, including revoked ones. */
export async function getDevice(db: Db, tenantId: string, id: string): Promise<DevicePublic | undefined> {
  if (!UUID_RE.test(id)) return undefined;
  return tenantScoped(db, tenantId).transaction((t) => deviceById(t.tx, tenantId, id));
}

/**
 * The tenant of an active device, known only by its id (the unauthenticated uninstall route,
 * `_specs/browser-extension.md`: `POST /api/devices/uninstalled` has no session to scope the
 * lookup with). `lookup_device_tenant` is a security-definer function, like
 * `lookup_device_enrollment_code` (migration 0011_device_uninstall); undefined for an unknown
 * or already-revoked device, so a repeat uninstall report is a safe no-op.
 */
export async function lookupDeviceTenant(db: Db, deviceId: string): Promise<string | undefined> {
  if (!UUID_RE.test(deviceId)) return undefined;
  const res = await db.execute(sql`select tenant_id from lookup_device_tenant(${deviceId})`);
  const [r] = (res as unknown as { rows: Array<{ tenant_id: string }> }).rows;
  return r?.tenant_id;
}

/** Rename an active device. "invalid" for a bad name; undefined for unknown or revoked devices. */
export async function renameDevice(db: Db, tenantId: string, id: string, name: string): Promise<DevicePublic | "invalid" | undefined> {
  const clean = normalizeDeviceName(name);
  if (!clean) return "invalid";
  if (!UUID_RE.test(id)) return undefined;
  return tenantScoped(db, tenantId).transaction(async (t) => {
    const [row] = await t.update(devices, { name: clean }, and(eq(devices.id, id), isNull(devices.revokedAt)));
    if (!row) return undefined;
    return deviceById(t.tx, tenantId, id);
  });
}

/** Revoke a device and every token with its device_id. Idempotent (`alreadyRevoked`). */
export async function revokeDevice(
  db: Db,
  input: { tenantId: string; deviceId: string; revokedBy: string | null; now?: Date },
): Promise<{ device: DevicePublic; alreadyRevoked: boolean } | undefined> {
  if (!UUID_RE.test(input.deviceId)) return undefined;
  const now = input.now ?? new Date();
  return tenantScoped(db, input.tenantId).transaction(async (t) => {
    const [row] = await t.tx
      .select({ revokedAt: devices.revokedAt })
      .from(devices)
      .where(and(eq(devices.tenantId, input.tenantId), eq(devices.id, input.deviceId)))
      .limit(1)
      .for("update");
    if (!row) return undefined;
    const alreadyRevoked = row.revokedAt !== null;
    if (!alreadyRevoked) {
      await t.update(devices, { revokedAt: now, revokedBy: input.revokedBy }, eq(devices.id, input.deviceId));
    }
    // Also on a repeat call, so a token can never outlive its device.
    await t.tx
      .update(desktopTokens)
      .set({ revokedAt: now })
      .where(and(eq(desktopTokens.tenantId, input.tenantId), eq(desktopTokens.deviceId, input.deviceId), isNull(desktopTokens.revokedAt)));
    const device = await deviceById(t.tx, input.tenantId, input.deviceId);
    return device ? { device, alreadyRevoked } : undefined;
  });
}

/**
 * A heartbeat from an active device: sets last_seen_at (and client_version when a valid
 * one is given) and clears offline_alerted_at so the next outage alerts again.
 */
export async function recordHeartbeat(
  db: Db,
  input: { tenantId: string; deviceId: string; clientVersion?: string; now?: Date },
): Promise<DevicePublic | undefined> {
  if (!UUID_RE.test(input.deviceId)) return undefined;
  const now = input.now ?? new Date();
  const clientVersion = input.clientVersion === undefined ? null : normalizeClientVersion(input.clientVersion);
  return tenantScoped(db, input.tenantId).transaction(async (t) => {
    const [row] = await t.update(
      devices,
      { lastSeenAt: now, offlineAlertedAt: null, ...(clientVersion ? { clientVersion } : {}) },
      and(eq(devices.id, input.deviceId), isNull(devices.revokedAt)),
    );
    if (!row) return undefined;
    return deviceById(t.tx, input.tenantId, input.deviceId);
  });
}

// ─── Jobs ──────────────────────────────────────────────────────────

/** Active, never offline-alerted devices silent since before `before`, across tenants (`list_stale_devices`). */
export async function listStaleDevices(db: Db, before: Date): Promise<{ id: string; tenantId: string }[]> {
  const res = await db.execute(sql`select id, tenant_id from list_stale_devices(${before.toISOString()}::timestamptz)`);
  return (res as unknown as { rows: Array<{ id: string; tenant_id: string }> }).rows.map((r) => ({ id: r.id, tenantId: r.tenant_id }));
}

/**
 * Mark a device offline-alerted at `at`, only if it is still active, not yet alerted and
 * silent for DEVICE_OFFLINE_AFTER_MS. Returns the device, or undefined when nothing changed
 * (so a concurrent heartbeat or a second sweep does not alert).
 */
export async function markDeviceOfflineAlerted(db: Db, tenantId: string, deviceId: string, at: Date): Promise<DevicePublic | undefined> {
  assertTenantId(tenantId);
  if (!UUID_RE.test(deviceId)) return undefined;
  const cutoff = new Date(at.getTime() - DEVICE_OFFLINE_AFTER_MS);
  return tenantScoped(db, tenantId).transaction(async (t) => {
    const [row] = await t.update(
      devices,
      { offlineAlertedAt: at },
      and(
        eq(devices.id, deviceId),
        isNull(devices.revokedAt),
        isNull(devices.offlineAlertedAt),
        sql`coalesce(${devices.lastSeenAt}, ${devices.createdAt}) < ${cutoff.toISOString()}::timestamptz`,
      ),
    );
    if (!row) return undefined;
    return deviceById(t.tx, tenantId, deviceId);
  });
}

/** Retention: old revoked devices and spent codes across tenants (`purge_old_devices()`). */
export async function purgeOldDevices(db: Db): Promise<number> {
  const res = await db.execute(sql`select purge_old_devices() as n`);
  const [r] = (res as unknown as { rows: Array<{ n: number | string }> }).rows;
  return Number(r?.n ?? 0);
}
