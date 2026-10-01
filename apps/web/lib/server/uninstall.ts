/**
 * Uninstall-signal HMAC (_specs/browser-extension.md "Uninstall"): the heartbeat response
 * carries an uninstall URL whose signature only that device's own heartbeat could have
 * produced, so a scammer telling someone to open `/uninstalled?d=...&s=...` for an arbitrary
 * device id gets nowhere without also knowing the signature.
 *
 *   key = HMAC-SHA256(AUTH_SECRET, "neo-uninstall-v1")
 *   sig = base64url(HMAC-SHA256(key, deviceId)), first 22 characters
 *
 * `AUTH_SECRET` unset outside a deployment (local dev, MOCK_MODE, tests) falls back to a
 * fixed key, so heartbeat/uninstall stay usable without one. On a deployment (`NODE_ENV`
 * production, or `VERCEL_ENV` production/preview — the same test as DEV_AUTH_BYPASS,
 * CLAUDE.md) an unset `AUTH_SECRET` disables signing entirely: no `uninstallUrl` is ever
 * minted, and every signature verification fails, so the route treats every request as
 * invalid rather than trusting an operator-chosen constant in production.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { isDeployedEnvironment, type EnvSource } from "@/lib/env";

const HMAC_LABEL = "neo-uninstall-v1";
const SIGNATURE_LENGTH = 22;
/** Never used on a deployment (see uninstallKey); only keeps local/test heartbeats stable. */
const DEV_FIXED_SECRET = "neo-dev-uninstall-secret-not-for-production";

/** The HMAC key, or undefined when signing/verifying must not happen at all. */
function uninstallKey(source: EnvSource): Buffer | undefined {
  const secret = source.AUTH_SECRET?.trim();
  if (secret) return createHmac("sha256", secret).update(HMAC_LABEL).digest();
  if (isDeployedEnvironment(source)) return undefined;
  return createHmac("sha256", DEV_FIXED_SECRET).update(HMAC_LABEL).digest();
}

/** `sig` for a device id, or undefined when signing is unavailable (see uninstallKey). */
export function signDeviceId(deviceId: string, source: EnvSource = process.env): string | undefined {
  const key = uninstallKey(source);
  if (!key) return undefined;
  return createHmac("sha256", key).update(deviceId).digest("base64url").slice(0, SIGNATURE_LENGTH);
}

/** Constant-time check. Always false when signing is unavailable or `sig` is malformed. */
export function verifyDeviceSignature(deviceId: string, sig: string, source: EnvSource = process.env): boolean {
  if (sig.length === 0 || sig.length > 128) return false; // defensive bound; a real signature is exactly SIGNATURE_LENGTH
  const expected = signDeviceId(deviceId, source);
  if (!expected) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** `<origin>/uninstalled?d=<deviceId>&s=<sig>`, or undefined when signing is unavailable. */
export function uninstallUrl(origin: string, deviceId: string, source: EnvSource = process.env): string | undefined {
  const sig = signDeviceId(deviceId, source);
  if (!sig) return undefined;
  return `${origin}/uninstalled?d=${encodeURIComponent(deviceId)}&s=${encodeURIComponent(sig)}`;
}
