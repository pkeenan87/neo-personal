/**
 * GET /api/artifacts/[id] — the session tenant's own evidence file, decrypted.
 *
 *   200   the bytes; Content-Disposition: attachment; Cache-Control: no-store;
 *         X-Content-Type-Options: nosniff; a sandboxing Content-Security-Policy
 *   ?inline=1 on an image artifact: Content-Disposition: inline with Content-Type
 *         fixed to the stored image type (PNG/JPEG/WebP/GIF). Ignored for other kinds.
 *   401   unauthenticated
 *   404   not_found (malformed id, unknown, expired, or another tenant's)
 *   503   storage_unavailable
 */
import { hashPii, logger } from "@neo/core";
import { isImageMimeType, sanitizeFilename } from "@/lib/attachments";
import { getArtifactStore } from "@/lib/server/artifacts";
import { jsonError } from "@/lib/server/http";
import { requireApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** RFC 6266 filename with an ASCII fallback and an RFC 5987 UTF-8 form. */
function contentDisposition(type: "attachment" | "inline", filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\;]/g, "_");
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { session, response } = await requireApiSession();
  if (!session) return response;
  const { id } = await params;
  if (!ID_RE.test(id)) return jsonError(404, "File not found.", "not_found");

  const store = getArtifactStore();
  if (!store) return jsonError(503, "Files aren't available on this server.", "storage_unavailable");

  let meta, bytes;
  try {
    meta = await store.get(id, session.tenantId);
    bytes = meta ? await store.read(id, session.tenantId) : undefined;
  } catch (err) {
    logger.error("Artifact read failed", "api.artifacts", {
      tenantId: session.tenantId,
      userIdHash: hashPii(session.userId),
      errorMessage: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
    });
    return jsonError(503, "Neo can't read that file right now. Please try again in a moment.", "storage_unavailable");
  }
  if (!meta || !bytes) return jsonError(404, "File not found. It may have expired.", "not_found");

  const inline = new URL(req.url).searchParams.get("inline") === "1" && meta.kind === "image" && isImageMimeType(meta.mimeType);
  const filename = sanitizeFilename(meta.filename, meta.kind === "image" ? "image" : meta.kind === "text" ? "text.txt" : "message.eml");
  const contentType = inline
    ? meta.mimeType
    : meta.kind === "image" && isImageMimeType(meta.mimeType)
      ? meta.mimeType
      : meta.kind === "text"
        ? "text/plain; charset=utf-8"
        : meta.kind === "eml" || meta.kind === "inbound_eml"
          ? "message/rfc822"
          : "application/octet-stream";

  return new Response(bytes as Uint8Array<ArrayBuffer>, {
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": contentDisposition(inline ? "inline" : "attachment", filename),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
}
