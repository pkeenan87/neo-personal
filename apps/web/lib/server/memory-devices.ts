/**
 * In-memory devices and enrollment codes when DATABASE_URL is unset (MOCK_MODE,
 * tests). Mirrors @neo/db devices.ts: same limits, return shapes and pending /
 * active rules. Member names come from the shared members map (memory-state.ts);
 * a household with no registered members accepts any user as its sole member,
 * like memory-household.ts. Monitoring tokens live in memory-desktop-tokens.ts.
 */
import {
  DEVICE_OFFLINE_AFTER_MS,
  ENROLLMENT_CODE_TTL_MS,
  MAX_DEVICES_PER_HOUSEHOLD,
  MAX_DEVICE_CLIENT_VERSION,
  MAX_PENDING_ENROLLMENT_CODES,
  MONITORING_SCOPES,
  hashEnrollmentCode,
  mintEnrollmentCode,
  normalizeDeviceInput,
  normalizeDeviceName,
  normalizeEnrollmentCode,
  type DeviceEnrollment,
  type DeviceInput,
  type DevicePublic,
  type EnrollSelfDeviceResult,
  type EnrollmentCodePreview,
  type EnrollmentCodePublic,
  type MembershipRole,
  type PolicyBundleRow,
  type RedeemEnrollmentCodeResult,
} from "@neo/db";
import { memoryInsertDeviceToken, memoryRevokeDeviceTokens } from "./memory-desktop-tokens";
import { memoryHouseholdName } from "./memory-household";
import { memoryMemberById, memoryMemberIdForUser } from "./memory-members";
import { memoryListMembers } from "./memory-state";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEVICE_RETENTION_MS = 90 * DAY_MS;
const CODE_RETENTION_MS = 30 * DAY_MS;

interface MemDevice {
  id: string;
  tenantId: string;
  userId: string | null;
  memberId: string;
  kind: DeviceInput["kind"];
  platform: DeviceInput["platform"];
  name: string;
  clientVersion: string;
  enrollment: DeviceEnrollment;
  enrolledBy: string | null;
  createdAt: Date;
  lastSeenAt: Date | null;
  offlineAlertedAt: Date | null;
  revokedAt: Date | null;
  revokedBy: string | null;
  policyVersionApplied: string | null;
}

interface MemCode {
  id: string;
  tenantId: string;
  userId: string | null;
  memberId: string | null;
  codeHash: string;
  createdBy: string | null;
  createdAt: Date;
  expiresAt: Date;
  redeemedAt: Date | null;
  deviceId: string | null;
  revokedAt: Date | null;
}

const g = globalThis as typeof globalThis & {
  __neoMemoryDevices?: { devices: Map<string, MemDevice>; codes: Map<string, MemCode> };
  __neoMemoryPolicyBundles?: Map<string, PolicyBundleRow>;
};

function state() {
  g.__neoMemoryDevices ??= { devices: new Map(), codes: new Map() };
  return g.__neoMemoryDevices;
}

export function resetMemoryDevices(): void {
  g.__neoMemoryDevices = undefined;
  g.__neoMemoryPolicyBundles = undefined;
}

// ─── Signed policy bundles (the twin of @neo/db policy-bundles.ts) ──

export function memoryGetPolicyBundle(tenantId: string, deviceId: string): PolicyBundleRow | undefined {
  const d = state().devices.get(deviceId);
  return d && d.tenantId === tenantId ? g.__neoMemoryPolicyBundles?.get(deviceId) : undefined;
}

export function memoryUpsertPolicyBundle(tenantId: string, row: PolicyBundleRow): void {
  const d = state().devices.get(row.deviceId);
  if (!d || d.tenantId !== tenantId) throw new Error("device is not in this household");
  (g.__neoMemoryPolicyBundles ??= new Map()).set(row.deviceId, row);
}

// ─── Helpers ───────────────────────────────────────────────────────

function nameOf(tenantId: string, userId: string | null): string | null {
  if (!userId) return null;
  return memoryListMembers(tenantId).find((m) => m.userId === userId)?.name ?? null;
}

/** The member's role, or undefined when they do not belong to the household. */
function membershipOf(tenantId: string, userId: string, fallbackRole: MembershipRole = "owner"): { role: MembershipRole } | undefined {
  const members = memoryListMembers(tenantId);
  if (members.length === 0) return { role: fallbackRole };
  const m = members.find((x) => x.userId === userId);
  return m ? { role: m.role } : undefined;
}

/** Who a code or device protects; undefined when the target is gone (the twin of devices.ts `resolveTarget`). */
function resolveTarget(
  tenantId: string,
  target: { userId: string | null; memberId: string | null },
  fallbackRole?: MembershipRole,
): { userId: string | null; memberId: string; role: MembershipRole | null } | undefined {
  if (target.userId) {
    const membership = membershipOf(tenantId, target.userId, fallbackRole);
    if (!membership) return undefined;
    return { userId: target.userId, memberId: target.memberId ?? memoryMemberIdForUser(tenantId, target.userId), role: membership.role };
  }
  if (!target.memberId) return undefined;
  const m = memoryMemberById(tenantId, target.memberId);
  if (!m) return undefined;
  return m.userId ? resolveTarget(tenantId, { userId: m.userId, memberId: m.id }) : { userId: null, memberId: m.id, role: null };
}

/** Name shown for the protected member: the account name, else the member's display name. */
function memberNameOf(tenantId: string, userId: string | null, memberId: string | null): string | null {
  if (userId) return nameOf(tenantId, userId);
  return memberId ? (memoryMemberById(tenantId, memberId)?.displayName ?? null) : null;
}

function toPublic(d: MemDevice): DevicePublic {
  return {
    id: d.id,
    tenantId: d.tenantId,
    userId: d.userId,
    memberId: d.memberId,
    memberName: memberNameOf(d.tenantId, d.userId, d.memberId),
    kind: d.kind,
    platform: d.platform,
    name: d.name,
    clientVersion: d.clientVersion,
    enrollment: d.enrollment,
    enrolledBy: d.enrolledBy,
    enrolledByName: nameOf(d.tenantId, d.enrolledBy),
    createdAt: d.createdAt,
    lastSeenAt: d.lastSeenAt,
    offlineAlertedAt: d.offlineAlertedAt,
    revokedAt: d.revokedAt,
    policyVersionApplied: d.policyVersionApplied,
  };
}

function codeToPublic(c: MemCode): EnrollmentCodePublic {
  return {
    id: c.id,
    userId: c.userId,
    memberId: c.memberId,
    memberName: memberNameOf(c.tenantId, c.userId, c.memberId),
    createdBy: c.createdBy,
    createdAt: c.createdAt,
    expiresAt: c.expiresAt,
  };
}

function pendingCode(c: MemCode, now: Date): boolean {
  return !c.redeemedAt && !c.revokedAt && c.expiresAt.getTime() > now.getTime();
}

function newestFirst<T extends { createdAt: Date }>(a: T, b: T): number {
  return b.createdAt.getTime() - a.createdAt.getTime();
}

function activeDeviceCount(tenantId: string): number {
  let n = 0;
  for (const d of state().devices.values()) if (d.tenantId === tenantId && !d.revokedAt) n++;
  return n;
}

function codeByInput(input: string): MemCode | undefined {
  const code = normalizeEnrollmentCode(input);
  if (!code) return undefined;
  const hash = hashEnrollmentCode(code);
  for (const c of state().codes.values()) if (c.codeHash === hash) return c;
  return undefined;
}

function normalizeClientVersion(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const v = s.trim();
  const len = [...v].length;
  if (len < 1 || len > MAX_DEVICE_CLIENT_VERSION || /[\u0000-\u001f\u007f]/.test(v)) return null;
  return v;
}

/** Insert an active device and its monitoring token. Null at the household device cap. */
function insertDevice(input: {
  tenantId: string;
  userId: string | null;
  role: MembershipRole | null;
  memberId: string;
  device: DeviceInput;
  enrollment: DeviceEnrollment;
  enrolledBy: string | null;
  now: Date;
}): { token: string; tokenId: string; record: ReturnType<typeof memoryInsertDeviceToken>["record"]; device: DevicePublic } | null {
  if (activeDeviceCount(input.tenantId) >= MAX_DEVICES_PER_HOUSEHOLD) return null;
  const row: MemDevice = {
    id: crypto.randomUUID(),
    tenantId: input.tenantId,
    userId: input.userId,
    memberId: input.memberId,
    kind: input.device.kind,
    platform: input.device.platform,
    name: input.device.name,
    clientVersion: input.device.clientVersion,
    enrollment: input.enrollment,
    enrolledBy: input.enrolledBy,
    createdAt: input.now,
    lastSeenAt: null,
    offlineAlertedAt: null,
    revokedAt: null,
    revokedBy: null,
    policyVersionApplied: null,
  };
  state().devices.set(row.id, row);
  const minted = memoryInsertDeviceToken({
    userId: input.userId,
    tenantId: input.tenantId,
    role: input.role,
    memberId: input.memberId,
    name: input.device.name,
    deviceId: row.id,
    scopes: MONITORING_SCOPES,
  });
  return { token: minted.token, tokenId: minted.record.id, record: minted.record, device: toPublic(row) };
}

/** Whether a device exists and is not revoked (monitoring token resolution). */
export function memoryDeviceIsActive(tenantId: string, deviceId: string): boolean {
  const d = state().devices.get(deviceId);
  return Boolean(d && d.tenantId === tenantId && !d.revokedAt);
}

/** The member of an active device, or null (monitoring token resolution). */
export function memoryDeviceMemberId(tenantId: string, deviceId: string): string | null {
  const d = state().devices.get(deviceId);
  return d && d.tenantId === tenantId && !d.revokedAt ? d.memberId : null;
}

// ─── Owner: enrollment codes ───────────────────────────────────────

export function memoryCreateEnrollmentCode(
  input: { tenantId: string; createdBy: string; now?: Date } & ({ userId: string; memberId?: undefined } | { memberId: string; userId?: undefined }),
): { code: string; record: EnrollmentCodePublic } | { error: "not_member" | "code_limit" | "device_limit" } {
  const now = input.now ?? new Date();
  const target = resolveTarget(
    input.tenantId,
    input.memberId !== undefined ? { userId: null, memberId: input.memberId } : { userId: input.userId, memberId: null },
  );
  if (!target) return { error: "not_member" };
  const pending = [...state().codes.values()].filter((c) => c.tenantId === input.tenantId && pendingCode(c, now));
  if (pending.length >= MAX_PENDING_ENROLLMENT_CODES) return { error: "code_limit" };
  if (activeDeviceCount(input.tenantId) >= MAX_DEVICES_PER_HOUSEHOLD) return { error: "device_limit" };
  const code = mintEnrollmentCode();
  const row: MemCode = {
    id: crypto.randomUUID(),
    tenantId: input.tenantId,
    userId: target.userId,
    memberId: target.memberId,
    codeHash: hashEnrollmentCode(code),
    createdBy: input.createdBy,
    createdAt: now,
    expiresAt: new Date(now.getTime() + ENROLLMENT_CODE_TTL_MS),
    redeemedAt: null,
    deviceId: null,
    revokedAt: null,
  };
  state().codes.set(row.id, row);
  return { code, record: codeToPublic(row) };
}

/** Pending codes, newest first. */
export function memoryListPendingEnrollmentCodes(tenantId: string, now = new Date()): EnrollmentCodePublic[] {
  return [...state().codes.values()]
    .filter((c) => c.tenantId === tenantId && pendingCode(c, now))
    .sort(newestFirst)
    .map(codeToPublic);
}

/** Cancel a code. True when it exists in the household (also when already revoked or used). */
export function memoryRevokeEnrollmentCode(tenantId: string, id: string, now = new Date()): boolean {
  const c = state().codes.get(id);
  if (!c || c.tenantId !== tenantId) return false;
  if (!c.revokedAt && !c.redeemedAt) c.revokedAt = now;
  return true;
}

// ─── Client: preview and redeem ────────────────────────────────────

export function memoryPreviewEnrollmentCode(input: { code: string; now?: Date }): EnrollmentCodePreview | null {
  const now = input.now ?? new Date();
  const c = codeByInput(input.code);
  if (!c || !pendingCode(c, now)) return null;
  if (!resolveTarget(c.tenantId, c)) return null;
  const owner = memoryListMembers(c.tenantId).find((m) => m.role === "owner");
  return {
    householdName: memoryHouseholdName(c.tenantId),
    memberName: memberNameOf(c.tenantId, c.userId, c.memberId),
    ownerName: owner?.name ?? null,
    expiresAt: c.expiresAt,
  };
}

export function memoryRedeemEnrollmentCode(input: { code: string; device: DeviceInput; now?: Date }): RedeemEnrollmentCodeResult {
  const device = normalizeDeviceInput(input.device);
  if (!device) return { status: "invalid" };
  const now = input.now ?? new Date();
  const c = codeByInput(input.code);
  if (!c || !pendingCode(c, now)) return { status: "not_found" };
  const target = resolveTarget(c.tenantId, c);
  if (!target) return { status: "not_found" };
  const enrolled = insertDevice({
    tenantId: c.tenantId,
    userId: target.userId,
    role: target.role,
    memberId: target.memberId,
    device,
    enrollment: "code",
    enrolledBy: c.createdBy,
    now,
  });
  if (!enrolled) return { status: "device_limit" };
  c.redeemedAt = now;
  c.deviceId = enrolled.device.id;
  return {
    status: "enrolled",
    token: enrolled.token,
    tokenId: enrolled.tokenId,
    device: enrolled.device,
    householdName: memoryHouseholdName(c.tenantId),
    memberName: enrolled.device.memberName,
    createdBy: c.createdBy,
  };
}

/** Self-enrollment through device authorization (`self`, enrolled by the member). */
export function memoryEnrollSelfDevice(input: {
  tenantId: string;
  userId: string;
  role: MembershipRole;
  device: DeviceInput;
  now?: Date;
}): EnrollSelfDeviceResult {
  const device = normalizeDeviceInput(input.device);
  if (!device) return { error: "invalid" };
  const membership = membershipOf(input.tenantId, input.userId, input.role);
  if (!membership) return { error: "not_member" };
  const enrolled = insertDevice({
    tenantId: input.tenantId,
    userId: input.userId,
    role: membership.role,
    memberId: memoryMemberIdForUser(input.tenantId, input.userId),
    device,
    enrollment: "self",
    enrolledBy: input.userId,
    now: input.now ?? new Date(),
  });
  if (!enrolled) return { error: "device_limit" };
  return { token: enrolled.token, tokenId: enrolled.tokenId, record: enrolled.record, device: enrolled.device };
}

// ─── Household: devices ────────────────────────────────────────────

/** Active devices, newest first; `memberId` restricts to one member's devices, `userId` to the member behind an account. */
export function memoryListDevices(tenantId: string, opts: { userId?: string; memberId?: string } = {}): DevicePublic[] {
  return [...state().devices.values()]
    .filter(
      (d) =>
        d.tenantId === tenantId &&
        !d.revokedAt &&
        (opts.memberId === undefined || d.memberId === opts.memberId) &&
        (opts.userId === undefined || d.userId === opts.userId || d.memberId === memoryMemberIdForUser(tenantId, opts.userId)),
    )
    .sort(newestFirst)
    .map(toPublic);
}

/** One device, including revoked ones. */
export function memoryGetDevice(tenantId: string, id: string): DevicePublic | undefined {
  const d = state().devices.get(id);
  return d && d.tenantId === tenantId ? toPublic(d) : undefined;
}

/** The tenant of an active device, known only by its id (the unauthenticated uninstall route). */
export function memoryLookupDeviceTenant(id: string): string | undefined {
  const d = state().devices.get(id);
  return d && !d.revokedAt ? d.tenantId : undefined;
}

export function memoryRenameDevice(tenantId: string, id: string, name: string): DevicePublic | "invalid" | undefined {
  const clean = normalizeDeviceName(name);
  if (!clean) return "invalid";
  const d = state().devices.get(id);
  if (!d || d.tenantId !== tenantId || d.revokedAt) return undefined;
  d.name = clean;
  return toPublic(d);
}

/** Revoke a device and its tokens. Idempotent (`alreadyRevoked`). */
export function memoryRevokeDevice(input: {
  tenantId: string;
  deviceId: string;
  revokedBy: string | null;
  now?: Date;
}): { device: DevicePublic; alreadyRevoked: boolean } | undefined {
  const d = state().devices.get(input.deviceId);
  if (!d || d.tenantId !== input.tenantId) return undefined;
  const now = input.now ?? new Date();
  const alreadyRevoked = d.revokedAt !== null;
  if (!alreadyRevoked) {
    d.revokedAt = now;
    d.revokedBy = input.revokedBy;
  }
  memoryRevokeDeviceTokens(input.tenantId, input.deviceId, now);
  return { device: toPublic(d), alreadyRevoked };
}

/** Sets last_seen_at (and a valid client version), clears offline_alerted_at; undefined if revoked. */
export function memoryRecordHeartbeat(input: {
  tenantId: string;
  deviceId: string;
  clientVersion?: string;
  policyVersion?: string;
  now?: Date;
}): DevicePublic | undefined {
  const d = state().devices.get(input.deviceId);
  if (!d || d.tenantId !== input.tenantId || d.revokedAt) return undefined;
  d.lastSeenAt = input.now ?? new Date();
  if (input.policyVersion) d.policyVersionApplied = input.policyVersion;
  d.offlineAlertedAt = null;
  const clientVersion = input.clientVersion === undefined ? null : normalizeClientVersion(input.clientVersion);
  if (clientVersion) d.clientVersion = clientVersion;
  return toPublic(d);
}

/**
 * Revoke a member's active devices (and their tokens) and pending codes in a household,
 * as detachMember does on leave or removal.
 */
export function memoryDetachMemberDevices(tenantId: string, userId: string, now = new Date()): void {
  for (const d of state().devices.values()) {
    if (d.tenantId === tenantId && d.userId === userId && !d.revokedAt) {
      memoryRevokeDevice({ tenantId, deviceId: d.id, revokedBy: null, now });
    }
  }
  for (const c of state().codes.values()) {
    if (c.tenantId === tenantId && c.userId === userId && pendingCode(c, now)) c.revokedAt = now;
  }
}

// ─── Jobs ──────────────────────────────────────────────────────────

/** Active, never offline-alerted devices silent (last seen, else created) since before `before`. */
export function memoryListStaleDevices(before: Date): { id: string; tenantId: string }[] {
  return [...state().devices.values()]
    .filter((d) => !d.revokedAt && !d.offlineAlertedAt && (d.lastSeenAt ?? d.createdAt).getTime() < before.getTime())
    .map((d) => ({ id: d.id, tenantId: d.tenantId }));
}

/** Mark offline-alerted only if still active, not yet alerted and silent for DEVICE_OFFLINE_AFTER_MS. */
export function memoryMarkDeviceOfflineAlerted(tenantId: string, deviceId: string, at: Date): DevicePublic | undefined {
  const d = state().devices.get(deviceId);
  if (!d || d.tenantId !== tenantId || d.revokedAt || d.offlineAlertedAt) return undefined;
  if ((d.lastSeenAt ?? d.createdAt).getTime() >= at.getTime() - DEVICE_OFFLINE_AFTER_MS) return undefined;
  d.offlineAlertedAt = at;
  return toPublic(d);
}

/** Retention: devices revoked > 90 days ago, codes redeemed/revoked/expired > 30 days ago. */
export function memoryPurgeOldDevices(now = new Date()): number {
  let n = 0;
  for (const [id, c] of state().codes) {
    if ((c.redeemedAt ?? c.revokedAt ?? c.expiresAt).getTime() < now.getTime() - CODE_RETENTION_MS) {
      state().codes.delete(id);
      n++;
    }
  }
  for (const [id, d] of state().devices) {
    if (d.revokedAt && d.revokedAt.getTime() < now.getTime() - DEVICE_RETENTION_MS) {
      state().devices.delete(id);
      for (const c of state().codes.values()) if (c.deviceId === id) c.deviceId = null;
      n++;
    }
  }
  return n;
}

/** A deleted household takes its devices, codes and device tokens with it (FK cascade). */
export function memoryDeleteTenantDevices(tenantId: string, now = new Date()): void {
  for (const [id, d] of state().devices) {
    if (d.tenantId !== tenantId) continue;
    memoryRevokeDeviceTokens(tenantId, id, now);
    state().devices.delete(id);
  }
  for (const [id, c] of state().codes) if (c.tenantId === tenantId) state().codes.delete(id);
}
