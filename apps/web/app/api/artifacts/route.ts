/**
 * POST /api/artifacts — upload evidence files (_specs/intake.md).
 *
 *   request   multipart/form-data, one or more `file` fields (≤ 4 per request, ≤ 4 MB total)
 *             .eml / message/rfc822 ≤ 2 MB → eml; PNG/JPEG/WebP/GIF ≤ 3 MB → image; text/plain ≤ 512 KB → text
 *   200       { artifacts: [{ id, kind, filename, mimeType, sizeBytes, sha256 }] }  (same order as the files)
 *   400       bad_request (not multipart, no file, too many files)
 *   401       unauthenticated
 *   413       too_large (a file over its kind's limit, or the request over 4 MB)
 *   415       unsupported_type (content does not match an accepted type; HEIC is refused with its own message)
 *   429       rate_limited (30 uploads per tenant per hour, per instance) + Retry-After
 *   503       storage_unavailable (artifacts unconfigured, or the store failed)
 *
 * The type is decided by content (magic bytes / UTF-8 + header structure), not
 * by the declared type. All files are validated before any is stored.
 */
import { hashPii, logger } from "@neo/core";
import { ATTACHMENT_LIMITS, formatBytes, sanitizeFilename } from "@/lib/attachments";
import type { ArtifactUploadResponse, UploadedArtifact } from "@/lib/api-types";
import { detectArtifactType, getArtifactStore, maxBytesFor, takeUploadSlots } from "@/lib/server/artifacts";
import { jsonError } from "@/lib/server/http";
import { requireApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Multipart framing on top of the files themselves. */
const MULTIPART_OVERHEAD = 64 * 1024;

export async function POST(req: Request): Promise<Response> {
  const { session, response } = await requireApiSession();
  if (!session) return response;

  const store = getArtifactStore();
  if (!store) {
    return jsonError(503, "File uploads aren't configured on this server yet. Paste the text of the message instead.", "storage_unavailable");
  }

  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
    return jsonError(400, "Send files as multipart/form-data in a field named \"file\".", "bad_request");
  }
  const declaredLength = Number(req.headers.get("content-length") ?? "0");
  if (declaredLength > ATTACHMENT_LIMITS.totalBytes + MULTIPART_OVERHEAD) {
    return jsonError(413, "Those files are too large together (max 4 MB per upload).", "too_large");
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonError(400, "Couldn't read the upload.", "bad_request");
  }
  const files = form.getAll("file").filter((f): f is File => typeof f !== "string");
  if (files.length === 0) return jsonError(400, "Attach at least one file.", "bad_request");
  if (files.length > ATTACHMENT_LIMITS.filesPerUpload) {
    return jsonError(400, `Attach at most ${ATTACHMENT_LIMITS.filesPerUpload} files at a time.`, "bad_request");
  }
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > ATTACHMENT_LIMITS.totalBytes) {
    return jsonError(413, "Those files are too large together (max 4 MB per upload).", "too_large");
  }

  // Validate everything first so a bad file stores nothing.
  const accepted: Array<{ bytes: Uint8Array; kind: "eml" | "image" | "text"; mimeType: string; filename: string }> = [];
  for (const file of files) {
    const filename = sanitizeFilename(file.name, "attachment");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const type = detectArtifactType(bytes, file.type, file.name);
    if (!type.ok) {
      return type.reason === "heic"
        ? jsonError(415, "HEIC photos aren't supported yet. Take the screenshot as PNG or JPEG (or share it as JPEG) and try again.", "unsupported_type")
        : jsonError(415, `${filename} isn't a supported file. Upload an .eml email, a PNG/JPEG/WebP/GIF screenshot, or a .txt file.`, "unsupported_type");
    }
    const max = maxBytesFor(type.kind);
    if (bytes.byteLength > max) {
      const hint =
        type.kind === "eml"
          ? " Remove large attachments from the email, or forward it to your Neo address instead."
          : type.kind === "image"
            ? " Try a smaller screenshot."
            : "";
      return jsonError(413, `${filename} is too large (${formatBytes(bytes.byteLength)}; max ${formatBytes(max)}).${hint}`, "too_large");
    }
    accepted.push({ bytes, kind: type.kind, mimeType: type.mimeType, filename });
  }

  const slot = takeUploadSlots(session.tenantId, accepted.length);
  if (!slot.ok) {
    return Response.json(
      { error: "You've uploaded a lot of files in the last hour. Please try again later.", code: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(slot.retryAfterSeconds), "Cache-Control": "no-store" } },
    );
  }

  const out: UploadedArtifact[] = [];
  try {
    for (const a of accepted) {
      const meta = await store.put({
        tenantId: session.tenantId,
        userId: session.userId,
        kind: a.kind,
        filename: a.filename,
        mimeType: a.mimeType,
        bytes: a.bytes,
        source: "upload",
      });
      out.push({ id: meta.id, kind: meta.kind, filename: meta.filename ?? a.filename, mimeType: meta.mimeType, sizeBytes: meta.sizeBytes, sha256: meta.sha256 });
    }
  } catch (err) {
    logger.error("Artifact upload failed", "api.artifacts", {
      tenantId: session.tenantId,
      userIdHash: hashPii(session.userId),
      errorMessage: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
    });
    return jsonError(503, "Neo can't store files right now. Please try again in a moment.", "storage_unavailable");
  }

  logger.info("Artifacts uploaded", "api.artifacts", { tenantId: session.tenantId, userIdHash: hashPii(session.userId) });
  const body: ArtifactUploadResponse = { artifacts: out };
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}
