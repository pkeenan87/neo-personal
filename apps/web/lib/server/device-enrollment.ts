/**
 * Device enrollment and management (_specs/device-enrollment.md): the session-level
 * operations behind /api/household/{members/[userId]/enrollment-codes,enrollment-codes,devices}
 * and /api/devices/*. Role checks, rate limits, audit, alerts and the member email live
 * here; storage is lib/server/devices.ts (db or memory). Every failure comes back as an
 * `Outcome` like lib/server/household.ts.
 */
import { hashPii, logger } from "@neo/core";
import { DEVICE_OFFLINE_AFTER_MS, normalizeDeviceInput, type DevicePublic } from "@neo/db";
import { detectionLists } from "@neo/tools";
import type {
  CreateEnrollmentCodeResponse,
  DeviceItem,
  EnrollDeviceResponse,
  EnrollmentCodeItem,
  EnrollmentPreviewResponse,
  HeartbeatResponse,
} from "@/lib/household-types";
import type { NeoSession } from "@/lib/session";
import { alertDeviceOffline, alertDeviceRemoved, tenantMembers } from "./alerts";
import { recordAudit } from "./audit";
import {
  createEnrollmentCode,
  getDevice,
  listDevices,
  listPendingEnrollmentCodes,
  listStaleDevices,
  lookupDeviceTenant,
  markDeviceOfflineAlerted,
  previewEnrollmentCode,
  recordHeartbeat,
  redeemEnrollmentCode,
  renameDevice,
  revokeDevice,
  revokeEnrollmentCode,
  toDeviceItem,
  toEnrollmentCodeItem,
} from "./devices";
import { renderDeviceEnrolledEmail } from "./email/household-email";
import { getMailer } from "./email/resend";
import type { Outcome } from "./household";
import { takeRateSlot } from "./rate-limit";
import { expectedToolsByDevice } from "./signals/expected-tools";
import { uninstallUrl, verifyDeviceSignature } from "./uninstall";
import { household } from "./verdict-data";

const HOUR_MS = 60 * 60 * 1000;
/** Preview and enroll share one bucket per client IP: a wrong guess costs one of 10 per hour. */
export const DEVICE_ENROLL_LIMIT = { limit: 10, windowMs: HOUR_MS } as const;
/** Heartbeats per device. */
export const HEARTBEAT_LIMIT = { limit: 12, windowMs: HOUR_MS } as const;
/** How often clients should send a heartbeat. */
export const HEARTBEAT_SECONDS = 3600;

function fail(status: number, code: string, message: string): Outcome<never> {
  return { ok: false, status, code, message };
}

function rateLimited(retryAfterSeconds: number): Outcome<never> {
  return { ok: false, status: 429, code: "rate_limited", message: "Too many attempts. Please try again later.", retryAfterSeconds };
}

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

const OWNER_ONLY = fail(403, "forbidden", "Only the household owner can do this.");
const DEVICE_NOT_FOUND = fail(404, "not_found", "That device is not in your household.");
const CODE_NOT_FOUND = fail(404, "not_found", "This enrollment code is not valid. It may have expired, been used, or been cancelled.");
const DEVICE_LIMIT = fail(409, "device_limit", "This household already has the maximum number of devices. Remove one under Settings → Household.");

// ─── Household view ────────────────────────────────────────────────

/** Owners see every active device and pending code; members only their own devices. */
export async function householdDevices(session: NeoSession): Promise<{ devices: DeviceItem[]; enrollmentCodes: EnrollmentCodeItem[] }> {
  const owner = session.role === "owner";
  const [devices, codes, expectedTools] = await Promise.all([
    listDevices(session.tenantId, owner ? {} : { userId: session.userId }),
    owner ? listPendingEnrollmentCodes(session.tenantId) : Promise.resolve([]),
    expectedToolsByDevice(session.tenantId),
  ]);
  const now = new Date();
  return {
    devices: devices.map((d) => toDeviceItem(d, now, expectedTools.get(d.id) ?? [])),
    enrollmentCodes: codes.map(toEnrollmentCodeItem),
  };
}

// ─── Enrollment codes (owner) ──────────────────────────────────────

export async function createCode(session: NeoSession, userId: string): Promise<Outcome<CreateEnrollmentCodeResponse>> {
  if (session.role !== "owner") return OWNER_ONLY;
  const r = await createEnrollmentCode({ tenantId: session.tenantId, userId, createdBy: session.userId });
  if ("error" in r) {
    if (r.error === "not_member") return fail(404, "not_found", "That person is not in your household.");
    if (r.error === "code_limit") {
      return fail(409, "code_limit", "Your household has too many unused enrollment codes. Cancel one before adding another device.");
    }
    return DEVICE_LIMIT;
  }
  await recordAudit(session.tenantId, session.userId, "device.enrollment_code_created", { codeId: r.record.id, userId });
  return { ok: true, value: { id: r.record.id, code: r.code, expiresAt: r.record.expiresAt.toISOString(), memberName: r.record.memberName } };
}

/** Cancel a pending code. Idempotent for a code in the household; 404 for unknown ids. */
export async function revokeCode(session: NeoSession, id: string): Promise<Outcome<null>> {
  if (session.role !== "owner") return OWNER_ONLY;
  if (!(await revokeEnrollmentCode(session.tenantId, id))) return fail(404, "not_found", "That enrollment code does not exist.");
  await recordAudit(session.tenantId, session.userId, "device.enrollment_code_revoked", { codeId: id });
  return { ok: true, value: null };
}

// ─── Enrollment by code (no session) ───────────────────────────────

function takeEnrollSlot(ip: string): Outcome<never> | null {
  const slot = takeRateSlot("device-enroll", ip, DEVICE_ENROLL_LIMIT.limit, DEVICE_ENROLL_LIMIT.windowMs);
  return slot.ok ? null : rateLimited(slot.retryAfterSeconds);
}

function codeOf(body: Record<string, unknown> | null): string | null {
  const code = body?.code;
  return typeof code === "string" && code.trim() && code.length <= 64 ? code : null;
}

export async function previewEnrollment(ip: string, body: Record<string, unknown> | null): Promise<Outcome<EnrollmentPreviewResponse>> {
  const limited = takeEnrollSlot(ip);
  if (limited) return limited;
  const code = codeOf(body);
  if (!code) return fail(400, "invalid", 'Expected { "code": string }.');
  const p = await previewEnrollmentCode({ code });
  if (!p) return CODE_NOT_FOUND;
  return {
    ok: true,
    value: { householdName: p.householdName, memberName: p.memberName, ownerName: p.ownerName, expiresAt: p.expiresAt.toISOString() },
  };
}

export async function enrollWithCode(
  ip: string,
  body: Record<string, unknown> | null,
  origin: string,
): Promise<Outcome<EnrollDeviceResponse>> {
  const limited = takeEnrollSlot(ip);
  if (limited) return limited;
  const code = codeOf(body);
  const device = body
    ? normalizeDeviceInput({ kind: body.kind, platform: body.platform, name: body.name, clientVersion: body.clientVersion })
    : null;
  if (!code || !device) {
    return fail(
      400,
      "invalid",
      'Expected { "code": string, "kind": "browser_extension" | "desktop_agent", "platform": "chrome" | "edge" | "firefox" | "windows" | "macos" | "linux", "name": 1–64 characters, "clientVersion": 1–32 characters }.',
    );
  }
  const r = await redeemEnrollmentCode({ code, device });
  if (r.status !== "enrolled") {
    if (r.status === "device_limit") return DEVICE_LIMIT;
    if (r.status === "invalid") return fail(400, "invalid", "The device details are not valid.");
    return CODE_NOT_FOUND;
  }
  // @neo/db audits `device.enrolled` in the redemption transaction.
  logger.info("Device enrolled by code", "devices", { tenantId: r.device.tenantId, userIdHash: hashPii(r.device.userId) });
  if (r.createdBy !== r.device.userId) await emailEnrolledMember(r.device, r.householdName, origin);
  return {
    ok: true,
    value: { token: r.token, tokenId: r.tokenId, device: toDeviceItem(r.device), householdName: r.householdName, memberName: r.memberName },
  };
}

/** Tell the member a device now reports for them. Never throws: the device is enrolled either way. */
async function emailEnrolledMember(device: DevicePublic, householdName: string, origin: string): Promise<void> {
  const mailer = getMailer();
  if (!mailer) return;
  try {
    const members = await tenantMembers(device.tenantId);
    const member = members.find((m) => m.userId === device.userId);
    if (!member?.email) return;
    const enroller = device.enrolledBy ? members.find((m) => m.userId === device.enrolledBy) : undefined;
    const email = renderDeviceEnrolledEmail({
      enrolledByName: device.enrolledByName ?? enroller?.name ?? null,
      deviceName: device.name,
      householdName,
      url: `${origin}/settings/household`,
    });
    await mailer.send({ to: member.email, ...email, idempotencyKey: `device-enrolled:${device.id}` });
  } catch (err) {
    logger.error("Device enrolled email failed", "devices", { tenantId: device.tenantId, errorMessage: errText(err) });
  }
}

// ─── Management (browser session) ──────────────────────────────────

export async function renameHouseholdDevice(session: NeoSession, id: string, name: unknown): Promise<Outcome<{ device: DeviceItem }>> {
  if (session.role !== "owner") return OWNER_ONLY;
  if (typeof name !== "string") return fail(400, "invalid", 'Expected { "name": string }.');
  const r = await renameDevice(session.tenantId, id, name);
  if (r === "invalid") return fail(400, "invalid", "Device names are 1 to 64 characters.");
  if (!r) return DEVICE_NOT_FOUND;
  await recordAudit(session.tenantId, session.userId, "device.renamed", { deviceId: id });
  return { ok: true, value: { device: toDeviceItem(r) } };
}

/**
 * Remove a device: the owner, or the member it protects. A member's removal alerts the
 * owner (`device_removed`); the owner's own never does. Revoked devices are 404.
 */
export async function removeHouseholdDevice(session: NeoSession, id: string): Promise<Outcome<null>> {
  const device = await getDevice(session.tenantId, id);
  if (!device || device.revokedAt) return DEVICE_NOT_FOUND;
  const owner = session.role === "owner";
  if (!owner && device.userId !== session.userId) return fail(403, "forbidden", "You can only remove devices that protect you.");
  const r = await revokeDevice({ tenantId: session.tenantId, deviceId: id, revokedBy: session.userId });
  if (!r) return DEVICE_NOT_FOUND;
  if (r.alreadyRevoked) return { ok: true, value: null };
  const by = owner ? "owner" : "member";
  await recordAudit(session.tenantId, session.userId, "device.revoked", { deviceId: id, by });
  if (!owner) await alertDeviceRemoved(r.device, "member");
  return { ok: true, value: null };
}

// ─── Device self-service (scope `device`) ──────────────────────────

export async function heartbeat(
  session: NeoSession,
  deviceId: string,
  body: Record<string, unknown> | null,
  origin: string,
): Promise<Outcome<HeartbeatResponse>> {
  const slot = takeRateSlot("device-heartbeat", deviceId, HEARTBEAT_LIMIT.limit, HEARTBEAT_LIMIT.windowMs);
  if (!slot.ok) return rateLimited(slot.retryAfterSeconds);
  const clientVersion = body?.clientVersion;
  if (clientVersion !== undefined && clientVersion !== null && (typeof clientVersion !== "string" || clientVersion.length > 32)) {
    return fail(400, "invalid", 'Expected { "clientVersion"?: string of at most 32 characters }.');
  }
  const device = await recordHeartbeat({
    tenantId: session.tenantId,
    deviceId,
    ...(typeof clientVersion === "string" && clientVersion.trim() ? { clientVersion } : {}),
  });
  // Revoked since the token resolved.
  if (!device) return fail(401, "unauthenticated", "This device is no longer connected to a household.");
  const url = uninstallUrl(origin, deviceId);
  return {
    ok: true,
    value: {
      device: toDeviceItem(device),
      householdName: (await household(session)).name,
      memberName: device.memberName,
      heartbeatSeconds: HEARTBEAT_SECONDS,
      listsVersion: detectionLists().version,
      ...(url ? { uninstallUrl: url } : {}),
    },
  };
}

/** "Stop protecting this device": revoke the device and its token; alerts the owner unless it protects an owner. */
export async function unenrollSelf(session: NeoSession, deviceId: string): Promise<Outcome<null>> {
  const r = await revokeDevice({ tenantId: session.tenantId, deviceId, revokedBy: null });
  if (!r) return fail(401, "unauthenticated", "This device is no longer connected to a household.");
  if (r.alreadyRevoked) return { ok: true, value: null };
  await recordAudit(session.tenantId, session.userId, "device.revoked", { deviceId, by: "device" });
  await alertDeviceRemoved(r.device, "device");
  return { ok: true, value: null };
}

// ─── Uninstall report (no session; _specs/browser-extension.md "Uninstall") ────────

/**
 * `POST /api/devices/uninstalled { d, s }`: no session, only an HMAC signature only that
 * device's own heartbeat response could have produced. A valid signature for a still-active
 * device revokes it (and its tokens) and raises `device_removed` `by: "device"`, same as
 * `unenrollSelf`. Anything else — a bad or missing signature, an unknown id, or a device
 * already revoked — is a silent no-op: the caller never learns which. Never throws; storage
 * failures are swallowed so the route can always answer 204 (a retry from the browser or from
 * the person re-opening the link is harmless either way).
 */
export async function reportUninstalled(deviceId: string, sig: string): Promise<void> {
  try {
    if (!verifyDeviceSignature(deviceId, sig)) return;
    const tenantId = await lookupDeviceTenant(deviceId);
    if (!tenantId) return; // unknown id, or already revoked (nothing left to do)
    const r = await revokeDevice({ tenantId, deviceId, revokedBy: null });
    if (!r || r.alreadyRevoked) return;
    await recordAudit(tenantId, r.device.userId, "device.revoked", { deviceId, by: "device" });
    await alertDeviceRemoved(r.device, "device");
  } catch (err) {
    logger.error("Uninstall report failed", "devices", { errorMessage: errText(err) });
  }
}

// ─── Offline sweep (Inngest `devices-offline`, hourly) ─────────────

export interface OfflineSweepDeps {
  listStale(before: Date): Promise<{ id: string; tenantId: string }[]>;
  markOffline(tenantId: string, deviceId: string, at: Date): Promise<DevicePublic | undefined>;
  alertOffline(device: DevicePublic): Promise<boolean>;
}

export function createOfflineSweepDeps(): OfflineSweepDeps {
  return { listStale: listStaleDevices, markOffline: markDeviceOfflineAlerted, alertOffline: alertDeviceOffline };
}

/**
 * Raise one `device_offline` per silent device (48 h without a heartbeat). The conditional
 * mark makes a re-run or a concurrent sweep skip devices already handled; a heartbeat
 * clears the mark, so the next outage alerts again.
 */
export async function runOfflineDeviceSweep(
  deps: OfflineSweepDeps = createOfflineSweepDeps(),
  now = new Date(),
): Promise<{ stale: number; marked: number; alerted: number; errors: number }> {
  const stale = await deps.listStale(new Date(now.getTime() - DEVICE_OFFLINE_AFTER_MS));
  let marked = 0;
  let alerted = 0;
  let errors = 0;
  for (const s of stale) {
    try {
      const device = await deps.markOffline(s.tenantId, s.id, now);
      if (!device) continue;
      marked++;
      if (await deps.alertOffline(device)) alerted++;
    } catch (err) {
      errors++;
      logger.error("Offline device sweep failed for a device", "devices", { tenantId: s.tenantId, errorMessage: errText(err) });
    }
  }
  const result = { stale: stale.length, marked, alerted, errors };
  if (stale.length > 0) logger.info("Offline device sweep finished", "devices", result);
  return result;
}
