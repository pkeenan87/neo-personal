/**
 * Attachment rules and the note format shared by the server (building the
 * user message for /api/agent) and the browser (composer checks, rendering
 * history). No server-only imports: this file ships to the client.
 *
 * In the persisted user message every attachment is announced by one text
 * block (the "note"), and an image note is followed by its `image` block:
 *
 *   [Attached file: invoice.eml (eml, 12 KB). Use analyze_email with artifact_ref "<id>".]
 *   [Attached image: screenshot.png (image, 240 KB), id "<id>".]
 *
 * The UI parses these notes back into thumbnails and chips.
 */

export type AttachmentKind = "eml" | "image" | "text" | "inbound_eml";

/** What the UI shows for an attachment (from an upload response or a parsed note). */
export interface AttachmentRef {
  id: string;
  kind: AttachmentKind;
  filename: string;
  /** Human-readable size, e.g. "12 KB". */
  size: string;
}

export const ATTACHMENT_LIMITS = {
  /** Files per POST /api/artifacts request. */
  filesPerUpload: 4,
  /** Total bytes per upload request (Vercel caps request bodies at 4.5 MB). */
  totalBytes: 4 * 1024 * 1024,
  emlBytes: 2 * 1024 * 1024,
  imageBytes: 3 * 1024 * 1024,
  textBytes: 512 * 1024,
  /** Attachments per /api/agent turn. */
  perMessage: 5,
  /** Client-side downscale target for the long edge of an image. */
  imageLongEdgePx: 1568,
  /** Uploads per tenant per hour. */
  uploadsPerHour: 30,
} as const;

export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];

export function isImageMimeType(v: string): v is ImageMimeType {
  return (IMAGE_MIME_TYPES as readonly string[]).includes(v);
}

/** `accept` attribute for the composer's file input. */
export const ACCEPT_ATTRIBUTE = ".eml,message/rfc822,.png,.jpg,.jpeg,.webp,.gif,image/png,image/jpeg,image/webp,image/gif,.txt,text/plain";

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A filename safe to put in a note the model reads and the UI re-parses:
 * no control or bidi characters, no quotes or brackets, at most 100 chars.
 */
export function sanitizeFilename(name: string | undefined, fallback = "attachment"): string {
  const cleaned = (name ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
    .replace(/["`]/g, "'")
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .replace(/\s+/g, " ")
    .trim();
  const base = cleaned.split(/[\\/]/).pop() ?? "";
  return (base || fallback).slice(0, 100);
}

/** The text block announcing an attachment in the user message. */
export function attachmentNote(a: { id: string; kind: AttachmentKind; filename?: string; sizeBytes: number }): string {
  const name = sanitizeFilename(a.filename, a.kind === "image" ? "image" : "file");
  const size = formatBytes(a.sizeBytes);
  return a.kind === "image"
    ? `[Attached image: ${name} (image, ${size}), id "${a.id}".]`
    : `[Attached file: ${name} (${a.kind}, ${size}). Use analyze_email with artifact_ref "${a.id}".]`;
}

const NOTE_RE =
  /^\[Attached (?:file|image): (.+) \((eml|text|image|inbound_eml), ([^)]+)\)[.,] .*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"\.?\]$/;

/** Parse a note back into an AttachmentRef; null for any other text. */
export function parseAttachmentNote(text: string): AttachmentRef | null {
  const m = NOTE_RE.exec(text.trim());
  if (!m) return null;
  return { filename: m[1]!, kind: m[2] as AttachmentKind, size: m[3]!, id: m[4]! };
}

/** URL of an artifact's bytes; `inline` shows an image in the browser instead of downloading it. */
export function artifactUrl(id: string, inline = false): string {
  return `/api/artifacts/${encodeURIComponent(id)}${inline ? "?inline=1" : ""}`;
}
