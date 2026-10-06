import { createHash, createHmac, randomBytes } from "node:crypto";
import { isDeployedEnvironment } from "@/lib/env";
import { ArtifactDecryptError, decryptArtifact, deriveKey, encryptArtifact, masterKeyFromEnv } from "@neo/core";

type EnvSource = Readonly<Record<string, string | undefined>>;
export type MonitoredAddressIdentity = { tenantId: string; userId: string; addressId: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const VERIFICATION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/u;
const ADDRESS_DIGEST_LABEL = "neo-breach-addr-v1";
const GLOBAL_DIGEST_LABEL = "neo-breach-global-v1";
const ADDRESS_ENCRYPTION_LABEL = "neo-breach-address-encryption-v1";

const DEV_MASTER_KEY = "neo-dev-breach-monitoring-not-for-production";

function requiredMasterKey(source: EnvSource): Uint8Array {
  const key = masterKeyFromEnv(source as NodeJS.ProcessEnv);
  if (key) return key;
  // Deterministic dev key only outside a deployment; deployed with no key fails closed.
  if (!isDeployedEnvironment(source)) return new Uint8Array(createHash("sha256").update(DEV_MASTER_KEY, "utf8").digest());
  throw new Error("NEO_MASTER_KEY is required for breach monitoring");
}

function requireIdentity(identity: MonitoredAddressIdentity): void {
  if (!identity.tenantId || !identity.userId || !identity.addressId) {
    throw new Error("tenantId, userId and addressId are required for monitored-address encryption");
  }
}

export function normalizeBreachAddress(address: string): string {
  const normalized = address.trim().toLowerCase();
  if (!EMAIL_RE.test(normalized)) throw new Error("A valid email address is required");
  return normalized;
}

export async function deriveMonitoredAddressDigest(
  tenantId: string,
  address: string,
  source: EnvSource = process.env,
): Promise<string> {
  if (!tenantId) throw new Error("tenantId is required for monitored-address digest");
  const normalized = normalizeBreachAddress(address);
  const key = deriveKey(requiredMasterKey(source), ADDRESS_DIGEST_LABEL, tenantId);
  return createHmac("sha256", key).update(normalized, "utf8").digest("hex");
}

/** Inngest-only global lookup coordination key; never persist or log this value. */
export async function deriveGlobalBreachQueryDigest(
  address: string,
  source: EnvSource = process.env,
): Promise<string> {
  const normalized = normalizeBreachAddress(address);
  const key = deriveKey(requiredMasterKey(source), GLOBAL_DIGEST_LABEL, "");
  return createHmac("sha256", key).update(normalized, "utf8").digest("hex");
}

function addressAad(identity: MonitoredAddressIdentity): string {
  requireIdentity(identity);
  return `neo:breach-address:v1:${identity.tenantId}:${identity.userId}:${identity.addressId}`;
}

export function encryptMonitoredAddress(
  address: string,
  identity: MonitoredAddressIdentity,
  source: EnvSource = process.env,
): Uint8Array {
  const normalized = normalizeBreachAddress(address);
  const key = deriveKey(requiredMasterKey(source), ADDRESS_ENCRYPTION_LABEL, identity.tenantId);
  return encryptArtifact(key, new TextEncoder().encode(normalized), addressAad(identity));
}

export function decryptMonitoredAddress(
  encrypted: Uint8Array,
  identity: MonitoredAddressIdentity,
  source: EnvSource = process.env,
): string {
  const key = deriveKey(requiredMasterKey(source), ADDRESS_ENCRYPTION_LABEL, identity.tenantId);
  const plaintext = decryptArtifact(key, encrypted, addressAad(identity));
  let address: string;
  try {
    address = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  } catch {
    throw new ArtifactDecryptError("monitored address is not valid UTF-8");
  }
  try {
    return normalizeBreachAddress(address);
  } catch {
    throw new ArtifactDecryptError("decrypted monitored address is invalid");
  }
}

/** Raw high-entropy token is returned once for the verification email; only its hash is stored. */
export function issueVerificationToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashVerificationToken(token: string): string {
  if (!VERIFICATION_TOKEN_RE.test(token) || Buffer.from(token, "base64url").length !== 32) {
    throw new Error("Invalid breach verification token");
  }
  return createHash("sha256").update(token, "utf8").digest("hex");
}
