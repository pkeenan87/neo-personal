/**
 * Client-side image preparation for uploads (_specs/intake.md): scale
 * screenshots down to ≤ 1568 px on the long edge (Claude's vision sweet spot)
 * and re-encode as PNG (kept when small enough) or JPEG. Browser only; when
 * the browser cannot decode the image (or in tests), the file is returned as is
 * and the server's size limit applies.
 */
import { ATTACHMENT_LIMITS } from "./attachments";

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function renamed(name: string, type: string): string {
  const ext = type === "image/png" ? "png" : "jpg";
  const base = name.replace(/\.[^.]+$/, "") || "screenshot";
  return `${base}.${ext}`;
}

export async function downscaleImage(file: File, maxEdge: number = ATTACHMENT_LIMITS.imageLongEdgePx): Promise<File> {
  if (typeof document === "undefined" || typeof createImageBitmap !== "function") return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }
  try {
    const long = Math.max(bitmap.width, bitmap.height);
    const fits = long <= maxEdge && file.size <= ATTACHMENT_LIMITS.imageBytes;
    // Already small, or an animated-capable GIF within limits: keep the original bytes.
    if (fits && (file.type === "image/png" || file.type === "image/jpeg" || file.type === "image/gif")) return file;

    const scale = Math.min(1, maxEdge / long);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    let blob = file.type === "image/png" ? await toBlob(canvas, "image/png") : null;
    if (!blob || blob.size > ATTACHMENT_LIMITS.imageBytes) blob = await toBlob(canvas, "image/jpeg", 0.88);
    if (blob && blob.size > ATTACHMENT_LIMITS.imageBytes) blob = await toBlob(canvas, "image/jpeg", 0.7);
    if (!blob) return file;
    return new File([blob], renamed(file.name, blob.type), { type: blob.type });
  } finally {
    bitmap.close();
  }
}
