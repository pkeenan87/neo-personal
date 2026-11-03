/**
 * Signed policy bundles for devices (_specs/v2-m2-child.md section 4): compile the device's effective
 * policy, sign it, and cache the signature so the signing key is used only when the policy changes or
 * the bundle nears expiry. Postgres via @neo/db when DATABASE_URL is set, else memory.
 *
 * A failure to read the policy layers is NOT turned into Standard here (signals do that, so a lookup
 * problem never stops signal processing): an empty bundle would lift a child's blocks. It throws instead.
 */
import { canonicalJson, compileBundle, logger } from "@neo/core";
import { getProtectionLayers, tenantScoped, type DevicePublic } from "@neo/db";
import { base64urlEncode, type PolicyBundle, type PolicyEnvelope } from "@neo/verdict";
import type { DevicePolicyState } from "@/lib/household-types";
import type { DeviceSession } from "@/lib/session";
import { getDb } from "./db";
import { getDevice, getPolicyBundle, upsertPolicyBundle } from "./devices";
import { memoryHouseholdTimeZone, memoryMemberPolicyVersions, memoryMemberRecords, memoryProtection } from "./memory-members";
import { ifNoneMatchHits } from "./if-none-match";
import { getPolicySigningService, type PolicySigningService } from "./policy-signer";
import { takeRateSlot } from "./rate-limit";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Policy fetches per device. */
export const POLICY_LIMIT = { limit: 120, windowMs: HOUR_MS } as const;
/** A stored bundle is reused while it has more than this left; closer to expiry it is re-signed. */
export const POLICY_REUSE_MIN_REMAINING_MS = DAY_MS;

export const POLICY_CACHE_CONTROL = "private, no-cache";

type DeviceRef = Pick<DevicePublic, "id" | "tenantId" | "userId" | "memberId">;

/** Approved extra screen time that is still valid (filled by the child-request slice). */
async function loadGrants(): Promise<PolicyBundle["screenTime"]["grants"]> {
  return [];
}

/** The bundle for a device as of `now`, unsigned. Throws when the device has no member or the layers cannot be read. */
export async function compileDeviceBundle(device: DeviceRef, now = new Date()): Promise<PolicyBundle> {
  if (!device.memberId) throw new Error("device has no member");
  const memberId = device.memberId;
  const db = getDb();
  let base: Parameters<typeof compileBundle>[0]["layers"];
  let birthYear: number | null = null;
  let timeZone: string | null = null;
  if (db) {
    const l = await getProtectionLayers(tenantScoped(db, device.tenantId), { memberId, deviceId: device.id });
    base = { mode: l.mode, ...(l.household !== undefined ? { household: l.household } : {}), ...(l.member !== undefined ? { member: l.member } : {}), ...(l.device !== undefined ? { device: l.device } : {}) };
    birthYear = l.birthYear ?? null;
    timeZone = l.timeZone ?? null;
  } else {
    // The memory twin of getProtectionLayers: the member's mode, birth year and latest member-scope policy.
    const own = device.userId ? memoryProtection(device.tenantId, device.userId) : undefined;
    const rec = own ? undefined : memoryMemberRecords(device.tenantId).find((m) => m.id === memberId);
    const mode = own?.mode ?? rec?.mode ?? "standard";
    const member = memoryMemberPolicyVersions(device.tenantId, memberId).at(-1);
    base = { mode, ...(member !== undefined ? { member } : {}) };
    if (mode === "child") {
      birthYear = own?.birthYear ?? rec?.birthYear ?? null;
      timeZone = memoryHouseholdTimeZone(device.tenantId);
    }
  }
  return compileBundle({ device: { id: device.id }, member: { id: memberId }, layers: base, birthYear, timeZone, now, grants: await loadGrants() });
}

/** The current `policyVersion` for a device, computed without signing. */
export async function currentPolicyVersion(device: DeviceRef, now = new Date()): Promise<string> {
  return (await compileDeviceBundle(device, now)).policyVersion;
}

/**
 * `pending`: the device reported an older bundle than the current one. `update_needed`: Child mode is on
 * and the device has never reported a version (an older Neo build). Otherwise `current` (or `unknown`
 * when the current version could not be computed).
 */
export function devicePolicyState(mode: string, applied: string | null, current: string | null): DevicePolicyState {
  if (current === null) return "unknown";
  if (applied === null) return mode === "child" ? "update_needed" : "current";
  return applied === current ? "current" : "pending";
}

export type PolicyResult =
  | { ok: true; status: 200; envelope: PolicyEnvelope; policyVersion: string }
  | { ok: true; status: 304; policyVersion: string }
  | { ok: false; status: 404 | 429 | 503; code: string; message: string; retryAfterSeconds?: number };

let signerUnavailableLogged = false;

function envelopeBytes(bundle: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(bundle));
}

/** Sign (or reuse the stored signature of) the bundle. */
async function signedEnvelope(device: DeviceRef, bundle: PolicyBundle, signer: PolicySigningService, now: Date): Promise<PolicyEnvelope> {
  const stored = await getPolicyBundle(device.tenantId, device.id);
  if (stored && stored.policyVersion === bundle.policyVersion && stored.expiresAt.getTime() - now.getTime() > POLICY_REUSE_MIN_REMAINING_MS) {
    const currentKeyId = await signer.currentKeyId();
    if (currentKeyId !== null && stored.keyId === currentKeyId) {
      return { bundle: stored.bundle as PolicyBundle, sig: stored.sig, keyId: stored.keyId, alg: "ES256" };
    }
  }
  const signed = await signer.sign(envelopeBytes(bundle));
  const sig = base64urlEncode(signed.sig);
  await upsertPolicyBundle(device.tenantId, {
    deviceId: device.id,
    policyVersion: bundle.policyVersion,
    bundle: bundle as unknown as Record<string, unknown>,
    sig,
    keyId: signed.keyId,
    issuedAt: new Date(bundle.issuedAt),
    expiresAt: new Date(bundle.expiresAt),
  });
  return { bundle, sig, keyId: signed.keyId, alg: signed.alg };
}

/**
 * `GET /api/devices/policy`: the signed bundle of the calling device. The rate slot is taken first; a
 * revoked device gets 404; no signer gets 503 (never an unsigned bundle); a matching `If-None-Match` gets 304
 * without reading the stored row or signing. A client whose stored bundle expires within a day should omit
 * `If-None-Match`, since the version (and so the ETag) does not change when only the timestamps do.
 */
export async function servePolicy(session: DeviceSession, ifNoneMatch: string | null, now = new Date()): Promise<PolicyResult> {
  const slot = takeRateSlot("device-policy", session.deviceId, POLICY_LIMIT.limit, POLICY_LIMIT.windowMs);
  if (!slot.ok) return { ok: false, status: 429, code: "rate_limited", message: "Too many attempts. Please try again later.", retryAfterSeconds: slot.retryAfterSeconds };
  const device = await getDevice(session.tenantId, session.deviceId);
  if (!device || device.revokedAt || !device.memberId) return { ok: false, status: 404, code: "not_found", message: "This device is no longer connected to a household." };
  const signer = getPolicySigningService();
  if (!signer) {
    if (!signerUnavailableLogged) {
      signerUnavailableLogged = true;
      logger.error("Policy signing is unavailable; serving 503 from /api/devices/policy", "policy");
    }
    return { ok: false, status: 503, code: "policy_signing_unavailable", message: "Policy signing is not configured on this server." };
  }
  const bundle = await compileDeviceBundle(device, now);
  if (ifNoneMatchHits(ifNoneMatch, bundle.policyVersion)) return { ok: true, status: 304, policyVersion: bundle.policyVersion };
  try {
    return { ok: true, status: 200, envelope: await signedEnvelope(device, bundle, signer, now), policyVersion: bundle.policyVersion };
  } catch (err) {
    logger.error("Policy signing failed", "policy", { tenantId: session.tenantId, errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
    return { ok: false, status: 503, code: "policy_signing_failed", message: "The policy could not be signed. Try again shortly." };
  }
}

/** Test hook: let the "unavailable" log fire again. */
export function resetPolicyLogState(): void {
  signerUnavailableLogged = false;
}
