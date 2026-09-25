import type { ArtifactMeta, ArtifactStore, BlobClient } from "@neo/db";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * No-database fallback artifact store: metadata in memory over a BlobClient,
 * plaintext (`encrypted: false`), tenant-scoped on every read, expiry honoured.
 * Used only when DATABASE_URL is unset (MOCK_MODE demo, tests), like the
 * in-memory conversation store. With a database the @neo/db store is used.
 */
export function createInMemoryArtifactStore(opts: { blob: BlobClient; retentionDays?: number }): ArtifactStore {
  const retentionDays = opts.retentionDays ?? 30;
  const rows = new Map<string, ArtifactMeta & { url: string }>();
  const visible = (id: string, tenantId: string) => {
    const r = rows.get(id);
    return r && r.tenantId === tenantId && (!r.expiresAt || r.expiresAt.getTime() > Date.now()) ? r : undefined;
  };
  const strip = ({ url: _url, ...meta }: ArtifactMeta & { url: string }): ArtifactMeta => ({ ...meta });
  return {
    async put(input) {
      const id = crypto.randomUUID();
      const createdAt = new Date();
      const { url } = await opts.blob.put(`tenants/${input.tenantId}/artifacts/${id}.bin`, input.bytes, "application/octet-stream");
      const meta: ArtifactMeta & { url: string } = {
        id,
        tenantId: input.tenantId,
        userId: input.userId,
        kind: input.kind,
        ...(input.filename ? { filename: input.filename } : {}),
        mimeType: input.mimeType,
        sizeBytes: input.bytes.byteLength,
        sha256: await sha256Hex(input.bytes),
        encrypted: false,
        source: input.source,
        createdAt,
        expiresAt: new Date(createdAt.getTime() + retentionDays * 86_400_000),
        url,
      };
      rows.set(id, meta);
      return strip(meta);
    },
    async get(id, tenantId) {
      const r = visible(id, tenantId);
      return r ? strip(r) : undefined;
    },
    async read(id, tenantId) {
      const r = visible(id, tenantId);
      return r ? opts.blob.get(r.url) : undefined;
    },
    async delete(id, tenantId) {
      const r = rows.get(id);
      if (!r || r.tenantId !== tenantId) return;
      await opts.blob.del(r.url);
      rows.delete(id);
    },
    async listExpired(limit) {
      const now = Date.now();
      return [...rows.values()].filter((r) => r.expiresAt && r.expiresAt.getTime() <= now).slice(0, limit).map(strip);
    },
    async purge(id, tenantId) {
      const r = rows.get(id);
      if (!r || (tenantId !== undefined && r.tenantId !== tenantId)) return;
      await opts.blob.del(r.url);
      rows.delete(id);
    },
  };
}

