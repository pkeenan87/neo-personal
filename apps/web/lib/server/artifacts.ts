/**
 * Intake artifacts (_specs/intake.md): type detection by magic bytes, the
 * artifact store (encrypted in Vercel Blob in production; in-memory blob
 * client in MOCK_MODE / local without BLOB_READ_WRITE_TOKEN), the per-tenant
 * upload rate limit, and building the /api/agent user message from
 * attachments. Every store call is scoped by the session tenant id.
 */
import type { MessageParam } from "@neo/core";
import { ATTACHMENT_LIMITS, attachmentNote, isImageMimeType, type AttachmentKind, type ImageMimeType } from "@/lib/attachments";
import { env, isDeployedEnvironment } from "@/lib/env";
import { logger, masterKeyFromEnv as coreMasterKeyFromEnv } from "@neo/core";
import {
  createArtifactStore,
  createMemoryBlobClient,
  createVercelBlobClient,
  type ArtifactMeta,
  type ArtifactStore,
} from "@neo/db";
import { getDb } from "./db";
import { createInMemoryArtifactStore } from "./memory-artifact-store";

export type { ArtifactMeta, ArtifactStore };

/** NEO_MASTER_KEY as 32 bytes; undefined when unset or malformed (logged; artifacts then report "unconfigured"). */
export function masterKeyFromEnv(): Uint8Array | undefined {
  try {
    return coreMasterKeyFromEnv();
  } catch (err) {
    logger.error("NEO_MASTER_KEY is malformed", "artifacts", {
      errorMessage: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
    });
    return undefined;
  }
}

// ─── Type detection ────────────────────────────────────────────────

export type DetectedType =
  | { ok: true; kind: Exclude<AttachmentKind, "inbound_eml">; mimeType: string }
  | { ok: false; reason: "unsupported_type" | "heic" };

function startsWith(b: Uint8Array, sig: number[], offset = 0): boolean {
  if (b.length < offset + sig.length) return false;
  return sig.every((v, i) => b[offset + i] === v);
}

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** Image type from magic bytes, or undefined. */
export function sniffImage(b: Uint8Array): ImageMimeType | "image/heic" | undefined {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(b, ascii("GIF87a")) || startsWith(b, ascii("GIF89a"))) return "image/gif";
  if (startsWith(b, ascii("RIFF")) && startsWith(b, ascii("WEBP"), 8)) return "image/webp";
  if (startsWith(b, ascii("ftyp"), 4)) {
    const brand = String.fromCharCode(...b.slice(8, 12));
    if (["heic", "heix", "hevc", "heim", "heis", "mif1", "msf1", "avif"].includes(brand)) return "image/heic";
  }
  return undefined;
}

/** Valid UTF-8 without NUL bytes (so binary files cannot pass as text or email). */
export function decodeText(b: Uint8Array): string | undefined {
  if (b.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return undefined;
  }
}

const HEADER_LINE_RE = /^[!-9;-~]+:[ \t]?\S?/;

/** Looks like RFC 5322: the first non-empty line is a header field (optionally after an mbox "From " line). */
export function looksLikeEmail(text: string): boolean {
  const lines = text.replace(/^\ufeff/, "").split(/\r?\n/).slice(0, 50);
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === "") i++;
  if (lines[i]?.startsWith("From ")) i++;
  let headers = 0;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === "") break;
    if (/^[ \t]/.test(line)) continue; // folded continuation
    if (!HEADER_LINE_RE.test(line)) return false;
    headers++;
  }
  return headers >= 2;
}

function extensionOf(filename: string | undefined): string {
  const m = /\.([a-z0-9]+)$/i.exec(filename ?? "");
  return m ? m[1]!.toLowerCase() : "";
}

/**
 * Decide the artifact kind from the declared type and extension, then confirm
 * it by content: images by magic bytes (the stored type is the detected one),
 * emails and text by UTF-8 decoding (and header structure for .eml).
 */
export function detectArtifactType(bytes: Uint8Array, declaredType: string, filename?: string): DetectedType {
  const declared = declaredType.split(";")[0]!.trim().toLowerCase();
  const ext = extensionOf(filename);
  const image = sniffImage(bytes);
  if (image === "image/heic" || declared === "image/heic" || declared === "image/heif" || ext === "heic" || ext === "heif") {
    return { ok: false, reason: "heic" };
  }

  const wantsImage = declared.startsWith("image/") || ["png", "jpg", "jpeg", "webp", "gif"].includes(ext);
  const wantsEml = declared === "message/rfc822" || ext === "eml";
  const wantsText = declared === "text/plain" || ext === "txt";

  if (wantsImage) {
    if (image && (!declared.startsWith("image/") || isImageMimeType(declared))) return { ok: true, kind: "image", mimeType: image };
    return { ok: false, reason: "unsupported_type" };
  }
  if (image) return { ok: false, reason: "unsupported_type" }; // image bytes declared as something else
  if (wantsEml) {
    const text = decodeText(bytes);
    return text !== undefined && looksLikeEmail(text) ? { ok: true, kind: "eml", mimeType: "message/rfc822" } : { ok: false, reason: "unsupported_type" };
  }
  if (wantsText) {
    return decodeText(bytes) !== undefined ? { ok: true, kind: "text", mimeType: "text/plain" } : { ok: false, reason: "unsupported_type" };
  }
  return { ok: false, reason: "unsupported_type" };
}

export function maxBytesFor(kind: AttachmentKind): number {
  if (kind === "image") return ATTACHMENT_LIMITS.imageBytes;
  if (kind === "text") return ATTACHMENT_LIMITS.textBytes;
  return ATTACHMENT_LIMITS.emlBytes;
}

// ─── Store ─────────────────────────────────────────────────────────

/** "ok": configured; "memory": in-memory blob client (MOCK_MODE / local); "unconfigured": uploads refused. */
export type ArtifactsStatus = "ok" | "memory" | "unconfigured";

export function artifactsStatus(): ArtifactsStatus {
  const e = env();
  const hasKey = masterKeyFromEnv() !== undefined;
  // Production always requires the key; with a database, so does everything but MOCK_MODE.
  if (!hasKey && (e.VERCEL_ENV === "production" || (e.DATABASE_URL && !e.MOCK_MODE))) return "unconfigured";
  if (!hasKey && process.env.NEO_MASTER_KEY?.trim()) return "unconfigured"; // set but malformed
  if (!e.HAS_BLOB_TOKEN) {
    // A per-instance memory blob store loses files between serverless instances.
    if (isDeployedEnvironment() && !e.MOCK_MODE) return "unconfigured";
    return "memory";
  }
  return "ok";
}

const g = globalThis as typeof globalThis & { __neoArtifactStore?: { key: string; store: ArtifactStore } };

/**
 * The app's single artifact store (uploads, inbound mail, dashboard evidence,
 * retention job), or null when artifacts are unconfigured (callers return 503
 * storage_unavailable). With a database: @neo/db `createArtifactStore` over
 * Vercel Blob (or the memory blob client in MOCK_MODE / local), encrypted with
 * NEO_MASTER_KEY; plaintext only where artifactsStatus() tolerates a missing
 * key (MOCK_MODE or no database). Without a database: the in-memory store.
 */
export function getArtifactStore(): ArtifactStore | null {
  const status = artifactsStatus();
  if (status === "unconfigured") return null;
  const e = env();
  const masterKey = masterKeyFromEnv();
  const db = getDb();
  const key = [status, e.DATABASE_URL ?? "", masterKey ? "k" : "", e.ARTIFACT_RETENTION_DAYS].join("|");
  if (g.__neoArtifactStore?.key !== key) {
    const blob = status === "memory" ? createMemoryBlobClient() : createVercelBlobClient(process.env.BLOB_READ_WRITE_TOKEN);
    const store = db
      ? createArtifactStore(db, {
          blob,
          ...(masterKey ? { masterKey } : {}),
          retentionDays: e.ARTIFACT_RETENTION_DAYS,
          // artifactsStatus() already refused the no-key case outside MOCK_MODE.
          allowPlaintext: !masterKey,
        })
      : createInMemoryArtifactStore({ blob, retentionDays: e.ARTIFACT_RETENTION_DAYS });
    g.__neoArtifactStore = { key, store };
  }
  return g.__neoArtifactStore.store;
}

/** Test helper: drop the cached store (and its memory blobs). */
export function resetArtifactStore(): void {
  g.__neoArtifactStore = undefined;
  resetUploadRateLimit();
}

// ─── Upload rate limit ────────────────────────────────────────────
// Per instance, in memory (Phase 1; a serverless fleet multiplies the limit by
// its instance count). Phase 2 moves it to Upstash Redis.

const HOUR_MS = 60 * 60 * 1000;
const rl = globalThis as typeof globalThis & { __neoUploadRate?: Map<string, number[]> };

function uploadLog(): Map<string, number[]> {
  rl.__neoUploadRate ??= new Map();
  return rl.__neoUploadRate;
}

/** Reserve `count` uploads for the tenant. Returns seconds until a slot frees up when over the limit. */
export function takeUploadSlots(tenantId: string, count: number, now = Date.now()): { ok: true } | { ok: false; retryAfterSeconds: number } {
  const log = uploadLog();
  const recent = (log.get(tenantId) ?? []).filter((t) => t > now - HOUR_MS);
  if (recent.length + count > ATTACHMENT_LIMITS.uploadsPerHour) {
    log.set(tenantId, recent);
    const oldest = recent[Math.max(0, recent.length + count - ATTACHMENT_LIMITS.uploadsPerHour - 1)] ?? now;
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + HOUR_MS - now) / 1000)) };
  }
  for (let i = 0; i < count; i++) recent.push(now);
  log.set(tenantId, recent);
  return { ok: true };
}

export function resetUploadRateLimit(): void {
  rl.__neoUploadRate = new Map();
}

// ─── User message with attachments ────────────────────────────────

type ContentBlock = Exclude<MessageParam["content"], string>[number];

/**
 * The /api/agent user message: the typed text, then per attachment a note
 * block, and for images the image itself as a base64 block. `.eml` and text
 * bytes are never inlined; the model reaches them only through analyze_email,
 * whose result enters the conversation through wrapToolResult.
 * Returns null if an image cannot be read (expired between lookup and read).
 */
export async function buildUserContent(
  text: string,
  metas: ArtifactMeta[],
  store: ArtifactStore,
  tenantId: string,
): Promise<ContentBlock[] | null> {
  const blocks: ContentBlock[] = [{ type: "text", text }];
  for (const meta of metas) {
    blocks.push({ type: "text", text: attachmentNote(meta) });
    if (meta.kind === "image") {
      if (!isImageMimeType(meta.mimeType)) return null;
      const bytes = await store.read(meta.id, tenantId);
      if (!bytes) return null;
      blocks.push({ type: "image", source: { type: "base64", media_type: meta.mimeType, data: Buffer.from(bytes).toString("base64") } });
    }
  }
  return blocks;
}

/** Default text when the user sends attachments without typing anything. */
export function defaultAttachmentPrompt(metas: ArtifactMeta[]): string {
  return metas.length === 1 ? "Can you check this for me?" : "Can you check these for me?";
}
