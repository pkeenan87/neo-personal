/**
 * Envelope encryption for raw artifacts (.eml, screenshots) at rest.
 *
 *  - One master key (`NEO_MASTER_KEY`, 32 bytes, base64) per deployment.
 *  - Per-tenant data keys derived with HKDF-SHA256, info `neo-artifact-v1:<tenantId>`,
 *    so a tenant key never needs storing and one tenant's key opens nothing else.
 *  - AES-256-GCM with a random 12-byte IV and the artifact id as additional
 *    authenticated data, so a ciphertext cannot be moved to another artifact row.
 *
 * Layout: magic "NEO1" (4 bytes) | IV (12) | ciphertext | GCM tag (16).
 * Pure: Node `crypto` only, no I/O.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const MAGIC = Buffer.from("NEO1", "ascii");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const HKDF_INFO_PREFIX = "neo-artifact-v1:";
/** Fixed HKDF salt: domain separation only (the master key is already uniformly random). */
const HKDF_SALT = Buffer.from("neo-artifact-hkdf-salt-v1", "ascii");

export const ARTIFACT_CIPHERTEXT_OVERHEAD = MAGIC.length + IV_BYTES + TAG_BYTES;

/** Decryption failed: wrong key, wrong AAD (artifact id), truncated or tampered data. */
export class ArtifactDecryptError extends Error {
  constructor(message = "artifact decryption failed") {
    super(message);
    this.name = "ArtifactDecryptError";
  }
}

function assertKey(key: Uint8Array, what: string): void {
  if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) {
    throw new Error(`@neo/core: ${what} must be ${KEY_BYTES} bytes`);
  }
}

/**
 * The master key from `NEO_MASTER_KEY` (standard or URL-safe base64 of exactly 32 bytes).
 * Returns `undefined` when unset or blank; throws when set but malformed, so a typo in
 * production fails loudly instead of silently storing plaintext.
 */
export function masterKeyFromEnv(source: NodeJS.ProcessEnv = process.env): Uint8Array | undefined {
  const raw = source.NEO_MASTER_KEY?.trim();
  if (!raw) return undefined;
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) {
    throw new Error("@neo/core: NEO_MASTER_KEY must be base64");
  }
  const bytes = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (bytes.length !== KEY_BYTES) {
    throw new Error(`@neo/core: NEO_MASTER_KEY must decode to ${KEY_BYTES} bytes (got ${bytes.length})`);
  }
  return new Uint8Array(bytes);
}

/** Per-tenant data key: HKDF-SHA256(masterKey, info = "neo-artifact-v1:<tenantId>"), 32 bytes. */
export function deriveTenantKey(masterKey: Uint8Array, tenantId: string): Uint8Array {
  assertKey(masterKey, "master key");
  if (typeof tenantId !== "string" || tenantId.length === 0) {
    throw new Error("@neo/core: tenantId is required to derive an artifact key");
  }
  const info = Buffer.from(HKDF_INFO_PREFIX + tenantId, "utf8");
  return new Uint8Array(hkdfSync("sha256", masterKey, HKDF_SALT, info, KEY_BYTES));
}

/** AES-256-GCM encrypt. `aad` is the artifact id. Returns `NEO1 | iv | ciphertext | tag`. */
export function encryptArtifact(key: Uint8Array, plaintext: Uint8Array, aad: string): Uint8Array {
  assertKey(key, "artifact key");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return new Uint8Array(Buffer.concat([MAGIC, iv, body, tag]));
}

/** Inverse of `encryptArtifact`. Throws `ArtifactDecryptError` on any failure. */
export function decryptArtifact(key: Uint8Array, blob: Uint8Array, aad: string): Uint8Array {
  assertKey(key, "artifact key");
  if (!(blob instanceof Uint8Array) || blob.length < ARTIFACT_CIPHERTEXT_OVERHEAD) {
    throw new ArtifactDecryptError("artifact ciphertext is truncated");
  }
  const buf = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new ArtifactDecryptError("artifact ciphertext has an unknown format");
  }
  const iv = buf.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const body = buf.subarray(MAGIC.length + IV_BYTES, buf.length - TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return new Uint8Array(Buffer.concat([decipher.update(body), decipher.final()]));
  } catch {
    throw new ArtifactDecryptError();
  }
}
