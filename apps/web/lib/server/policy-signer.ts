/**
 * Signing for policy bundles (_specs/v2-m2-child.md section 4): ES256 (ECDSA P-256 / SHA-256), signature
 * as raw 64-byte r || s. One interface, three backends picked from the environment:
 *
 *   1. Vercel KMS      `NEO_POLICY_KMS_ISSUER` (the key never leaves KMS; must run inside a request)
 *   2. env key         `NEO_POLICY_SIGNING_KEY` (PKCS8 PEM, P-256), key id `NEO_POLICY_KEY_ID` or a fingerprint
 *   3. ephemeral key   neither set, and only outside production/preview (dev, MOCK_MODE, tests)
 *
 * With none of them on a production or preview deployment there is no signer (`null`) and the policy
 * route answers 503: a bundle is never served unsigned, and never signed with a throwaway key.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as nodeSign, verify as nodeVerify, type KeyObject } from "node:crypto";
import { logger } from "@neo/core";
import { PolicyPublicJwkSchema, POLICY_ALG, type PolicyKeyEntry, type PolicyPublicJwk } from "@neo/verdict";
import { isDeployedEnvironment, type EnvSource } from "../env";

export interface PolicySignature {
  /** Raw r || s, 64 bytes. */
  sig: Uint8Array;
  keyId: string;
  alg: typeof POLICY_ALG;
}

export interface PolicySigner {
  sign(bytes: Uint8Array): Promise<PolicySignature>;
}

export interface PolicySigningService extends PolicySigner {
  kind: "kms" | "env" | "ephemeral";
  /**
   * The key id bundles signed now carry, or null when it cannot be known without signing (KMS on a
   * cold instance with several published keys). A stored bundle is reused only when its key id equals this.
   */
  currentKeyId(): Promise<string | null>;
  /** Public keys for `GET /api/devices/policy/keys`. */
  publicKeys(): Promise<PolicyKeyEntry[]>;
}

const g = globalThis as typeof globalThis & {
  __neoPolicyEphemeralKey?: KeyObject;
  __neoPolicySigner?: { fingerprint: string; service: PolicySigningService };
  __neoPolicySignerOverride?: PolicySigningService | null;
  __neoPolicyJwks?: Map<string, { at: number; keys: PolicyKeyEntry[] }>;
  __neoPolicyWarned?: Set<string>;
};

function warnOnce(code: string, message: string): void {
  g.__neoPolicyWarned ??= new Set();
  if (g.__neoPolicyWarned.has(code)) return;
  g.__neoPolicyWarned.add(code);
  logger.error(message, "policy");
}

/** Test hook: use this service (or `null` for "no signer") instead of the environment; `undefined` restores normal selection. */
export function setPolicySigningServiceForTests(service: PolicySigningService | null | undefined): void {
  g.__neoPolicySignerOverride = service;
  g.__neoPolicySigner = undefined;
  g.__neoPolicyWarned = undefined;
  g.__neoPolicyJwks = undefined;
}

// ─── Signature encoding ────────────────────────────────────────────

/** Strip leading zeros of a DER INTEGER and left-pad to 32 bytes. */
function fixedInt(int: Uint8Array): Uint8Array {
  let i = 0;
  while (i < int.length - 1 && int[i] === 0) i++;
  const trimmed = int.subarray(i);
  if (trimmed.length === 0 || trimmed.length > 32) throw new Error("ECDSA signature integer out of range for P-256");
  const out = new Uint8Array(32);
  out.set(trimmed, 32 - trimmed.length);
  return out;
}

function derToRaw(der: Uint8Array): Uint8Array | null {
  let p = 0;
  if (der[p++] !== 0x30) return null;
  let len = der[p++];
  if (len === undefined) return null;
  if (len === 0x81) len = der[p++];
  else if (len > 0x80) return null;
  if (len === undefined || p + len !== der.length) return null;
  const ints: Uint8Array[] = [];
  for (let n = 0; n < 2; n++) {
    if (der[p++] !== 0x02) return null;
    const l = der[p++];
    if (l === undefined || l === 0 || l > 0x7f || p + l > der.length) return null;
    ints.push(der.subarray(p, p + l));
    p += l;
  }
  if (p !== der.length) return null;
  return new Uint8Array([...fixedInt(ints[0]!), ...fixedInt(ints[1]!)]);
}

/**
 * An ECDSA P-256 signature as raw 64-byte r || s. Accepts that form or ASN.1 DER (the `SEQUENCE { INTEGER r,
 * INTEGER s }` most KMS APIs return); anything else throws. A 64-byte value is taken as raw.
 */
export function normalizeEcdsaSignature(sig: Uint8Array): Uint8Array {
  if (sig.length === 64) return sig;
  const raw = derToRaw(sig);
  if (!raw) throw new Error(`unrecognized ECDSA signature encoding (${sig.length} bytes)`);
  return raw;
}

function verifyRaw(bytes: Uint8Array, sig: Uint8Array, jwk: PolicyPublicJwk): boolean {
  const key = createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, format: "jwk" });
  return nodeVerify("sha256", bytes, { key, dsaEncoding: "ieee-p1363" }, sig);
}

// ─── Env key and ephemeral key ─────────────────────────────────────

function localService(kind: "env" | "ephemeral", key: KeyObject, keyIdOverride?: string): PolicySigningService {
  const publicKey = createPublicKey(key);
  const spki = publicKey.export({ format: "der", type: "spki" });
  const fingerprint = createHash("sha256").update(spki).digest("hex").slice(0, 16);
  const keyId = keyIdOverride || (kind === "ephemeral" ? `ephemeral-${fingerprint}` : fingerprint);
  const exported = publicKey.export({ format: "jwk" });
  const jwk = PolicyPublicJwkSchema.parse({ kty: exported.kty, crv: exported.crv, x: exported.x, y: exported.y, kid: keyId, alg: POLICY_ALG, use: "sig" });
  return {
    kind,
    async sign(bytes) {
      return { sig: new Uint8Array(nodeSign("sha256", bytes, { key, dsaEncoding: "ieee-p1363" })), keyId, alg: POLICY_ALG };
    },
    async currentKeyId() {
      return keyId;
    },
    async publicKeys() {
      return [{ kid: keyId, alg: POLICY_ALG, jwk }];
    },
  };
}

/** Parse `NEO_POLICY_SIGNING_KEY`: a PKCS8 PEM that may carry literal `\n` sequences (a one-line env value); P-256 only. */
function parseSigningKey(pem: string): KeyObject {
  const key = createPrivateKey(pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem);
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("NEO_POLICY_SIGNING_KEY must be a P-256 (prime256v1) key");
  return key;
}

function ephemeralKey(): KeyObject {
  g.__neoPolicyEphemeralKey ??= generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  return g.__neoPolicyEphemeralKey;
}

// ─── Vercel KMS ────────────────────────────────────────────────────

const JWKS_TTL_MS = 60 * 60 * 1000;

function jwksCache(): Map<string, { at: number; keys: PolicyKeyEntry[] }> {
  g.__neoPolicyJwks ??= new Map();
  return g.__neoPolicyJwks;
}

/** The issuer's published keys (`https://kms.vercel.com/<issuerId>/jwks.json`), cached for an hour; a stale copy is served when a refresh fails. */
async function fetchJwks(issuerId: string, force = false, now = Date.now()): Promise<PolicyKeyEntry[]> {
  const cached = jwksCache().get(issuerId);
  if (cached && !force && now - cached.at < JWKS_TTL_MS) return cached.keys;
  try {
    const res = await fetch(`https://kms.vercel.com/${encodeURIComponent(issuerId)}/jwks.json`, { cache: "no-store" });
    if (!res.ok) throw new Error(`JWKS fetch failed (${res.status})`);
    const body = (await res.json()) as { keys?: unknown };
    const keys: PolicyKeyEntry[] = [];
    for (const raw of Array.isArray(body.keys) ? body.keys : []) {
      const jwk = PolicyPublicJwkSchema.safeParse(raw);
      if (jwk.success && jwk.data.kid) keys.push({ kid: jwk.data.kid, alg: POLICY_ALG, jwk: jwk.data });
    }
    if (keys.length === 0) throw new Error("JWKS has no P-256 keys");
    jwksCache().set(issuerId, { at: now, keys });
    return keys;
  } catch (err) {
    if (cached) return cached.keys;
    throw err;
  }
}

function kmsService(issuerId: string): PolicySigningService {
  // The key id of the last signature, trusted for as long as the JWKS cache is: after a rotation, bundles are re-signed within about an hour.
  let observed: { keyId: string; at: number } | null = null;
  return {
    kind: "kms",
    async sign(bytes) {
      const { signMessage } = await import("@vercel/kms");
      const r = await signMessage({ issuerId, message: bytes });
      if (!/ES256|P-?256/i.test(r.algorithm)) throw new Error(`KMS key algorithm is ${r.algorithm}, expected ES256`);
      const sig = normalizeEcdsaSignature(r.signature);
      await verifyAgainstJwks(issuerId, r.keyId, bytes, sig);
      observed = { keyId: r.keyId, at: Date.now() };
      return { sig, keyId: r.keyId, alg: POLICY_ALG };
    },
    async currentKeyId() {
      if (observed && Date.now() - observed.at < JWKS_TTL_MS) return observed.keyId;
      const keys = await fetchJwks(issuerId).catch(() => []);
      return keys.length === 1 ? keys[0]!.kid : null;
    },
    publicKeys: () => fetchJwks(issuerId),
  };
}

/**
 * Check a fresh KMS signature against the published key, so a signature in an unexpected encoding is
 * caught here and not by every client. An unreachable JWKS skips the check (logged); a key that is
 * published but does not verify throws.
 */
async function verifyAgainstJwks(issuerId: string, keyId: string, bytes: Uint8Array, sig: Uint8Array): Promise<void> {
  let keys: PolicyKeyEntry[];
  try {
    keys = await fetchJwks(issuerId);
    if (!keys.some((k) => k.kid === keyId)) keys = await fetchJwks(issuerId, true);
  } catch (err) {
    logger.warn("Policy key set unavailable; KMS signature not cross-checked", "policy", { errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
    return;
  }
  const key = keys.find((k) => k.kid === keyId);
  if (!key) throw new Error("KMS signing key is not in the issuer's JWKS");
  if (!verifyRaw(bytes, sig, key.jwk)) throw new Error("KMS signature does not verify against the published key");
}

// ─── Selection ─────────────────────────────────────────────────────

/** The signer for this environment, or `null` when none is available (the route then answers 503). */
export function getPolicySigningService(source: EnvSource = process.env): PolicySigningService | null {
  if (g.__neoPolicySignerOverride !== undefined) return g.__neoPolicySignerOverride;
  const issuer = source.NEO_POLICY_KMS_ISSUER?.trim();
  const pem = source.NEO_POLICY_SIGNING_KEY?.trim();
  const keyId = source.NEO_POLICY_KEY_ID?.trim();
  const deployed = isDeployedEnvironment(source);
  const fingerprint = issuer ? `kms:${issuer}` : pem ? `env:${pem}:${keyId ?? ""}` : deployed ? "none" : "ephemeral";
  if (g.__neoPolicySigner?.fingerprint === fingerprint) return g.__neoPolicySigner.service;

  let service: PolicySigningService | null = null;
  if (issuer) service = kmsService(issuer);
  else if (pem) {
    try {
      service = localService("env", parseSigningKey(pem), keyId);
    } catch (err) {
      warnOnce("bad_key", `NEO_POLICY_SIGNING_KEY is not usable (${err instanceof Error ? err.message : "invalid key"}); policy bundles cannot be signed`);
    }
  } else if (!deployed) service = localService("ephemeral", ephemeralKey());
  else warnOnce("no_signer", "No policy signer is configured (set NEO_POLICY_KMS_ISSUER or NEO_POLICY_SIGNING_KEY); GET /api/devices/policy answers 503");

  if (service) g.__neoPolicySigner = { fingerprint, service };
  return service;
}
