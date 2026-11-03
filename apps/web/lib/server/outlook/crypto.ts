/**
 * Encryption for the Outlook connector (_specs/outlook-connector.md). Three separate HKDF labels (so a key for one
 * purpose never opens another) with the tenant id as context, and AAD that binds each ciphertext to its row:
 *  - tokens   `neo-connector-v1`              AAD `outlook:v1:<tenantId>:<userId>:<connectorId>`. Bearer credentials for the mailbox.
 *  - cursor   `neo-connector-cursor-v1`       AAD `outlook-cursor:v1:<tenantId>:<userId>:<connectorId>`. The opaque delta URL is sensitive mailbox state.
 *  - msgid    `neo-connector-msgid-v1`        HMAC-SHA256 key for the seen-message fingerprint (not encryption: the Graph message id is never stored).
 *  - state    `neo-connector-oauth-state-v1`  AAD `outlook-state:v1:<tenantId>:<userId>:<stateId>`. The PKCE verifier is a secret needed to redeem the authorization code.
 * Deployed without NEO_MASTER_KEY every call throws (fail closed); a fixed dev key is used only when not deployed.
 */
import { createHash, createHmac } from "node:crypto";
import { isDeployedEnvironment } from "@/lib/env";
import { ArtifactDecryptError, decryptArtifact, deriveKey, encryptArtifact, masterKeyFromEnv } from "@neo/core";

type EnvSource = Readonly<Record<string, string | undefined>>;

export const OUTLOOK_TOKEN_LABEL = "neo-connector-v1";
export const OUTLOOK_CURSOR_LABEL = "neo-connector-cursor-v1";
export const OUTLOOK_STATE_LABEL = "neo-connector-oauth-state-v1";
export const OUTLOOK_MESSAGE_ID_LABEL = "neo-connector-msgid-v1";
const DEV_MASTER_KEY = "neo-dev-outlook-connector-not-for-production";

export type StoredTokens = { accessToken: string; refreshToken: string; /** ISO-8601 */ expiresAt: string };
export type DeltaCursor = {
  /** The opaque Graph URL: `next` resumes a run, `delta` is the steady-state cursor. */
  kind: "next" | "delta";
  link: string;
  /** False until the 30-day baseline run has reached the end of the mailbox window. */
  baselineComplete: boolean;
  /** ISO-8601 lower bound of the baseline window. */
  since: string;
  /** Candidate message ids already handled on the page this link returns, so a retried page never repeats them. */
  done?: string[];
};
export type ConnectorIdentity = { tenantId: string; userId: string; connectorId: string };
export type StateIdentity = { tenantId: string; userId: string; stateId: string };

function masterKey(source: EnvSource): Uint8Array {
  const key = masterKeyFromEnv(source as NodeJS.ProcessEnv);
  if (key) return key;
  if (!isDeployedEnvironment(source)) return new Uint8Array(createHash("sha256").update(DEV_MASTER_KEY, "utf8").digest());
  throw new Error("NEO_MASTER_KEY is required for the Outlook connector");
}

function need(...parts: string[]): void {
  if (parts.some((p) => !p)) throw new Error("tenantId, userId and connector or state id are required for Outlook encryption");
}

const enc = (label: string, tenantId: string, aad: string, plaintext: string, source: EnvSource) =>
  encryptArtifact(deriveKey(masterKey(source), label, tenantId), new TextEncoder().encode(plaintext), aad);

function dec(label: string, tenantId: string, aad: string, blob: Uint8Array, source: EnvSource): string {
  const plain = decryptArtifact(deriveKey(masterKey(source), label, tenantId), blob, aad);
  return new TextDecoder("utf-8", { fatal: true }).decode(plain);
}

export const tokenAad = (i: ConnectorIdentity) => (need(i.tenantId, i.userId, i.connectorId), `outlook:v1:${i.tenantId}:${i.userId}:${i.connectorId}`);
export const cursorAad = (i: ConnectorIdentity) => (need(i.tenantId, i.userId, i.connectorId), `outlook-cursor:v1:${i.tenantId}:${i.userId}:${i.connectorId}`);
export const stateAad = (i: StateIdentity) => (need(i.tenantId, i.userId, i.stateId), `outlook-state:v1:${i.tenantId}:${i.userId}:${i.stateId}`);

export function encryptTokens(tokens: StoredTokens, id: ConnectorIdentity, source: EnvSource = process.env): Uint8Array {
  return enc(OUTLOOK_TOKEN_LABEL, id.tenantId, tokenAad(id), JSON.stringify(tokens), source);
}

export function decryptTokens(blob: Uint8Array, id: ConnectorIdentity, source: EnvSource = process.env): StoredTokens {
  const v: unknown = parseJson(dec(OUTLOOK_TOKEN_LABEL, id.tenantId, tokenAad(id), blob, source));
  if (!isObject(v) || typeof v.accessToken !== "string" || typeof v.refreshToken !== "string" || typeof v.expiresAt !== "string") throw new ArtifactDecryptError("stored Outlook tokens are malformed");
  return { accessToken: v.accessToken, refreshToken: v.refreshToken, expiresAt: v.expiresAt };
}

export function encryptCursor(cursor: DeltaCursor, id: ConnectorIdentity, source: EnvSource = process.env): Uint8Array {
  return enc(OUTLOOK_CURSOR_LABEL, id.tenantId, cursorAad(id), JSON.stringify(cursor), source);
}

export function decryptCursor(blob: Uint8Array, id: ConnectorIdentity, source: EnvSource = process.env): DeltaCursor {
  const v: unknown = parseJson(dec(OUTLOOK_CURSOR_LABEL, id.tenantId, cursorAad(id), blob, source));
  if (!isObject(v) || (v.kind !== "next" && v.kind !== "delta") || typeof v.link !== "string" || typeof v.baselineComplete !== "boolean" || typeof v.since !== "string") throw new ArtifactDecryptError("stored Outlook cursor is malformed");
  const done = Array.isArray(v.done) ? v.done.filter((d): d is string => typeof d === "string") : undefined;
  return { kind: v.kind, link: v.link, baselineComplete: v.baselineComplete, since: v.since, ...(done?.length ? { done } : {}) };
}

export function encryptPkceVerifier(verifier: string, id: StateIdentity, source: EnvSource = process.env): Uint8Array {
  return enc(OUTLOOK_STATE_LABEL, id.tenantId, stateAad(id), verifier, source);
}

export function decryptPkceVerifier(blob: Uint8Array, id: StateIdentity, source: EnvSource = process.env): string {
  return dec(OUTLOOK_STATE_LABEL, id.tenantId, stateAad(id), blob, source);
}

/** Keyed fingerprint of a Graph message id (hex HMAC-SHA256 under a per-tenant key), stored to skip messages already handled. */
export function messageKey(graphMessageId: string, tenantId: string, source: EnvSource = process.env): string {
  need(tenantId, graphMessageId);
  return createHmac("sha256", deriveKey(masterKey(source), OUTLOOK_MESSAGE_ID_LABEL, tenantId)).update(graphMessageId, "utf8").digest("hex");
}

/** SHA-256 of the raw `state`; only this hash is stored. */
export function hashState(state: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(state, "utf8").digest());
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ArtifactDecryptError("stored Outlook value is not valid JSON");
  }
}
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
