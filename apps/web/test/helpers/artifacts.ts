/** Small synthetic evidence files generated in tests (no real people, .neo.test domains). */

/** A valid 1×1 transparent PNG. */
export const PNG_1X1 = Uint8Array.from(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"),
);

/** JPEG / GIF / WebP headers (enough for magic-byte detection). */
export const JPEG_HEAD = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
export const GIF_HEAD = new TextEncoder().encode("GIF89a\x01\x00\x01\x00");
export const WEBP_HEAD = Uint8Array.from([...new TextEncoder().encode("RIFF"), 0x24, 0, 0, 0, ...new TextEncoder().encode("WEBPVP8 ")]);
export const HEIC_HEAD = Uint8Array.from([0, 0, 0, 0x18, ...new TextEncoder().encode("ftypheic"), 0, 0, 0, 0]);

export const EML_TEXT = [
  "From: \"PayPal Security\" <security@paypa1-secure-login.neo.test>",
  "To: pat@example.com",
  "Subject: Your account has been limited",
  "Date: Mon, 1 Sep 2026 09:00:00 +0000",
  "Message-ID: <synthetic-1@paypa1-secure-login.neo.test>",
  "MIME-Version: 1.0",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "We noticed unusual activity. Verify your account at https://paypa1-secure-login.neo.test/verify within 24 hours.",
  "",
].join("\r\n");

export const EML = new TextEncoder().encode(EML_TEXT);

export function file(bytes: Uint8Array, name: string, type: string): File {
  return new File([bytes as Uint8Array<ArrayBuffer>], name, { type });
}

/** A multipart POST /api/artifacts request. */
export function uploadRequest(files: File[], headers: Record<string, string> = {}): Request {
  const form = new FormData();
  for (const f of files) form.append("file", f, f.name);
  return new Request("http://localhost/api/artifacts", { method: "POST", body: form, headers });
}
