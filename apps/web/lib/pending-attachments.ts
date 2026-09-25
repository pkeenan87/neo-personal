/**
 * Composer-side attachment handling (browser): classify dropped/pasted/picked
 * files, downscale screenshots, enforce the upload limits before anything is
 * sent, and track which files were already uploaded so a failed turn can be
 * resent without uploading again. The server re-checks everything by content.
 */
import type { UploadedArtifact } from "./api-types";
import { ATTACHMENT_LIMITS, formatBytes, isImageMimeType, sanitizeFilename, type AttachmentRef } from "./attachments";
import { downscaleImage } from "./image-downscale";

export type PendingKind = "image" | "eml" | "text";

export interface PendingAttachment {
  localId: string;
  file: File;
  kind: PendingKind;
  /** Object URL for an image thumbnail (revoke with releaseAttachments). */
  previewUrl?: string;
  /** Set once POST /api/artifacts stored it. */
  uploaded?: UploadedArtifact;
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
const HEIC = /\.(heic|heif)$/i;

export function classifyFile(file: File): { kind: PendingKind } | { error: string } {
  const type = file.type.toLowerCase();
  const name = file.name || "file";
  if (type === "image/heic" || type === "image/heif" || HEIC.test(name)) {
    return { error: "HEIC photos aren't supported yet. Take the screenshot as PNG or JPEG and try again." };
  }
  if (isImageMimeType(type) || (!type && IMAGE_EXT.test(name))) return { kind: "image" };
  if (type === "message/rfc822" || /\.eml$/i.test(name)) return { kind: "eml" };
  if (type === "text/plain" || /\.txt$/i.test(name)) return { kind: "text" };
  return { error: `${sanitizeFilename(name)} isn't supported. Attach an .eml email, a PNG/JPEG/WebP/GIF screenshot, or a .txt file.` };
}

function maxBytes(kind: PendingKind): number {
  return kind === "image" ? ATTACHMENT_LIMITS.imageBytes : kind === "text" ? ATTACHMENT_LIMITS.textBytes : ATTACHMENT_LIMITS.emlBytes;
}

function objectUrl(file: File): string | undefined {
  try {
    return typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : undefined;
  } catch {
    return undefined; // no preview; the chip shows the file name instead
  }
}

let seq = 0;
function localId(): string {
  seq += 1;
  return `att-${Date.now().toString(36)}-${seq}`;
}

/**
 * Turn raw files into pending attachments, appended after `existing`.
 * Returns the new ones plus user-facing errors for files that were refused.
 */
export async function preparePendingAttachments(
  files: File[],
  existing: readonly PendingAttachment[],
): Promise<{ added: PendingAttachment[]; errors: string[] }> {
  const added: PendingAttachment[] = [];
  const errors: string[] = [];
  let total = existing.reduce((n, a) => n + a.file.size, 0);
  for (const raw of files) {
    if (existing.length + added.length >= ATTACHMENT_LIMITS.filesPerUpload) {
      errors.push(`You can attach up to ${ATTACHMENT_LIMITS.filesPerUpload} files per message.`);
      break;
    }
    const c = classifyFile(raw);
    if ("error" in c) {
      errors.push(c.error);
      continue;
    }
    const file = c.kind === "image" ? await downscaleImage(raw) : raw;
    const max = maxBytes(c.kind);
    if (file.size > max) {
      errors.push(
        `${sanitizeFilename(file.name)} is too large (${formatBytes(file.size)}; max ${formatBytes(max)}).` +
          (c.kind === "eml" ? " Remove large attachments from the email, or forward it to your Neo address instead." : ""),
      );
      continue;
    }
    if (total + file.size > ATTACHMENT_LIMITS.totalBytes) {
      errors.push("Those files are too large together (max 4 MB per message).");
      continue;
    }
    total += file.size;
    const previewUrl = c.kind === "image" ? objectUrl(file) : undefined;
    added.push({ localId: localId(), file, kind: c.kind, ...(previewUrl ? { previewUrl } : {}) });
  }
  return { added, errors: [...new Set(errors)] };
}

/** A long paste as a `text` attachment (the message box keeps its 20,000-character limit). */
export function textFileFromPaste(text: string): File {
  return new File([text], "pasted-text.txt", { type: "text/plain" });
}

export function releaseAttachments(list: readonly PendingAttachment[]): void {
  for (const a of list) if (a.previewUrl && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(a.previewUrl);
}

export function toAttachmentRef(u: UploadedArtifact): AttachmentRef {
  return { id: u.id, kind: u.kind, filename: sanitizeFilename(u.filename), size: formatBytes(u.sizeBytes) };
}
