import { del as blobDel, get as blobGet, put as blobPut } from "@vercel/blob";

/** Minimal object storage used by the artifact store. Bytes are opaque (ciphertext). */
export interface BlobClient {
  put(path: string, bytes: Uint8Array, contentType: string): Promise<{ url: string }>;
  /** The stored bytes, or undefined when the blob does not exist. */
  get(url: string): Promise<Uint8Array | undefined>;
  /** Idempotent: deleting a missing blob succeeds. */
  del(url: string): Promise<void>;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * Vercel Blob (`@vercel/blob` 2.x) with `access: "private"`: blobs are readable only with
 * the store token, so a leaked URL alone reveals nothing (and the bytes are ciphertext).
 * `token` defaults to `BLOB_READ_WRITE_TOKEN` (the SDK also falls back to Vercel OIDC with
 * `BLOB_STORE_ID`). Paths are never overwritten and get no random suffix: the artifact id
 * in the path is already unique.
 */
export function createVercelBlobClient(token: string | undefined = process.env.BLOB_READ_WRITE_TOKEN): BlobClient {
  const auth = token ? { token } : {};
  return {
    async put(path, bytes, contentType) {
      const res = await blobPut(path, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
        access: "private",
        contentType,
        addRandomSuffix: false,
        allowOverwrite: false,
        ...auth,
      });
      return { url: res.url };
    },
    async get(url) {
      // Private blobs are fetched through the SDK with the token; bypass the CDN cache so a
      // purged blob is never served from cache.
      const res = await blobGet(url, { access: "private", useCache: false, ...auth });
      if (!res || res.statusCode !== 200) return undefined;
      return readAll(res.stream);
    },
    async del(url) {
      await blobDel(url, auth);
    },
  };
}

/** In-process blob store for tests and local development (MOCK_MODE without a Blob token). */
export function createMemoryBlobClient(): BlobClient & { readonly size: number; raw(url: string): Uint8Array | undefined } {
  const store = new Map<string, Uint8Array>();
  return {
    get size() {
      return store.size;
    },
    raw(url) {
      return store.get(url);
    },
    async put(path, bytes) {
      const url = `memory://blob/${path}`;
      if (store.has(url)) throw new Error(`@neo/db: blob already exists at ${path}`);
      store.set(url, Uint8Array.from(bytes));
      return { url };
    },
    async get(url) {
      const v = store.get(url);
      return v ? Uint8Array.from(v) : undefined;
    },
    async del(url) {
      store.delete(url);
    },
  };
}
