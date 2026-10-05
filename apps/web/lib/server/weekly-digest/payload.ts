import { createHash } from "node:crypto";
import { ArtifactDecryptError, decryptArtifact, deriveKey, encryptArtifact, masterKeyFromEnv } from "@neo/core";
import { z } from "zod";
import { isDeployedEnvironment, type EnvSource } from "@/lib/env";
import type { OutgoingEmail } from "../email/resend";

export type DigestPayloadIdentity = { tenantId: string; userId: string; isoWeek: string };
export type DigestStoredPayload = { email: OutgoingEmail; role: "owner" | "member"; deliveryCreatedAt: string };

const emailSchema = z.object({
  to: z.string().min(1).max(320),
  subject: z.string().min(1).max(998),
  html: z.string().max(200_000),
  text: z.string().max(200_000),
  idempotencyKey: z.string().min(1).max(256),
  headers: z.record(z.string(), z.string()).optional(),
}).strict();
const payloadSchema = z.object({
  email: emailSchema,
  role: z.enum(["owner", "member"]),
  deliveryCreatedAt: z.string().datetime(),
}).strict();

const DEV_MASTER_KEY = "neo-dev-weekly-digest-payload-not-for-production";
const PURPOSE = "neo-weekly-digest-payload-v1";

function encryptionKey(source: EnvSource): Uint8Array | undefined {
  const configured = masterKeyFromEnv(source as NodeJS.ProcessEnv);
  if (configured) return configured;
  if (isDeployedEnvironment(source)) return undefined;
  return new Uint8Array(createHash("sha256").update(DEV_MASTER_KEY, "utf8").digest());
}

function payloadAad(identity: DigestPayloadIdentity): string {
  return `digest:${identity.tenantId}:${identity.userId}:${identity.isoWeek}`;
}

export function encryptDigestPayload(
  payload: DigestStoredPayload,
  identity: DigestPayloadIdentity,
  source: EnvSource = process.env,
): Uint8Array | undefined {
  const master = encryptionKey(source);
  if (!master) return undefined;
  const key = deriveKey(master, PURPOSE, identity.tenantId);
  const plaintext = new TextEncoder().encode(JSON.stringify(payloadSchema.parse(payload)));
  return encryptArtifact(key, plaintext, payloadAad(identity));
}

export function decryptDigestPayload(
  encrypted: Uint8Array,
  identity: DigestPayloadIdentity,
  source: EnvSource = process.env,
): DigestStoredPayload {
  const master = encryptionKey(source);
  if (!master) throw new Error("weekly digest payload encryption key unavailable");
  const key = deriveKey(master, PURPOSE, identity.tenantId);
  const plaintext = decryptArtifact(key, encrypted, payloadAad(identity));
  try {
    return payloadSchema.parse(JSON.parse(new TextDecoder().decode(plaintext)));
  } catch {
    throw new ArtifactDecryptError("weekly digest payload is invalid");
  }
}
