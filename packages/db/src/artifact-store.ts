import { createHash, randomUUID } from "node:crypto";
import { and, eq, gt, isNull, or, sql, type SQL } from "drizzle-orm";
import { decryptArtifact, deriveTenantKey, encryptArtifact, logger } from "@neo/core";
import type { BlobClient } from "./blob.js";
import type { Db } from "./client.js";
import { artifacts, type ArtifactKind, type ArtifactSource } from "./schema/index.js";
import { assertTenantId, tenantScoped } from "./tenant.js";
import { parseIntEnv } from "./usage.js";

export type { ArtifactKind, ArtifactSource };

export type ArtifactMeta = {
  id: string;
  tenantId: string;
  userId: string;
  kind: ArtifactKind;
  filename?: string;
  mimeType: string;
  sizeBytes: number;
  /** Hex SHA-256 of the plaintext. */
  sha256: string;
  encrypted: boolean;
  source: ArtifactSource;
  createdAt: Date;
  expiresAt: Date | null;
};

export type PutArtifactInput = {
  tenantId: string;
  userId: string;
  kind: ArtifactKind;
  filename?: string;
  mimeType: string;
  bytes: Uint8Array;
  source: ArtifactSource;
};

export interface ArtifactStore {
  put(input: PutArtifactInput): Promise<ArtifactMeta>;
  /** Metadata, or undefined when missing, another tenant's, or expired. */
  get(id: string, tenantId: string): Promise<ArtifactMeta | undefined>;
  /** Decrypted bytes, or undefined when missing, another tenant's, expired, or the blob is gone. */
  read(id: string, tenantId: string): Promise<Uint8Array | undefined>;
  /** Delete the blob and the row (tenant-checked). No-op for unknown ids. */
  delete(id: string, tenantId: string): Promise<void>;
  /** Expired artifacts across all tenants, oldest expiry first (for the retention job). */
  listExpired(limit: number): Promise<ArtifactMeta[]>;
  /**
   * Delete blob + row regardless of expiry. Pass `tenantId` (from `listExpired`) when running
   * as the app role; without it the tenant is looked up directly, which only the owner role
   * can see through RLS.
   */
  purge(id: string, tenantId?: string): Promise<void>;
}

export type ArtifactStoreOptions = {
  blob: BlobClient;
  /** 32-byte master key (`masterKeyFromEnv()`). Required unless `allowPlaintext`. */
  masterKey?: Uint8Array;
  /** Days until an artifact expires. Default `NEO_ARTIFACT_RETENTION_DAYS` or 30. */
  retentionDays?: number;
  /**
   * Store plaintext (`encrypted: false`) when no master key is given. Only for MOCK_MODE and
   * in-memory development; ignored when `VERCEL_ENV=production`.
   */
  allowPlaintext?: boolean;
  /** Clock override for tests. */
  now?: () => Date;
};

/** The store cannot write: no master key and plaintext is not allowed. Maps to 503 `storage_unavailable`. */
export class ArtifactStoreUnavailableError extends Error {
  constructor(message = "artifact storage is not configured (NEO_MASTER_KEY is unset)") {
    super(message);
    this.name = "ArtifactStoreUnavailableError";
  }
}

export const DEFAULT_ARTIFACT_RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMPONENT = "artifact-store";

/** `NEO_ARTIFACT_RETENTION_DAYS` (positive integer), default 30. */
export function artifactRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const n = parseIntEnv(env.NEO_ARTIFACT_RETENTION_DAYS, DEFAULT_ARTIFACT_RETENTION_DAYS);
  return n > 0 ? n : DEFAULT_ARTIFACT_RETENTION_DAYS;
}

/** Blob path for an artifact's (cipher)bytes. */
export function artifactBlobPath(tenantId: string, artifactId: string): string {
  return `tenants/${tenantId}/artifacts/${artifactId}.bin`;
}

type ArtifactRow = typeof artifacts.$inferSelect;

function toMeta(r: ArtifactRow): ArtifactMeta {
  return {
    id: r.id,
    tenantId: r.tenantId,
    userId: r.userId,
    kind: r.kind,
    ...(r.filename != null ? { filename: r.filename } : {}),
    mimeType: r.mimeType,
    sizeBytes: r.sizeBytes,
    sha256: r.sha256,
    encrypted: r.encrypted,
    source: r.source,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
  };
}

/**
 * Tenant-scoped artifact storage with envelope encryption: bytes are encrypted with the
 * tenant key derived from the master key (HKDF, `@neo/core`), AAD = artifact id, and
 * written to `tenants/<tenantId>/artifacts/<id>.bin`; the row keeps metadata only.
 */
export function createArtifactStore(db: Db, opts: ArtifactStoreOptions): ArtifactStore {
  const { blob, masterKey } = opts;
  const now = opts.now ?? (() => new Date());
  const retentionDays = opts.retentionDays && opts.retentionDays > 0 ? opts.retentionDays : artifactRetentionDays();
  const plaintextAllowed = opts.allowPlaintext === true && process.env.VERCEL_ENV !== "production";

  const notExpired = (): SQL => or(isNull(artifacts.expiresAt), gt(artifacts.expiresAt, now())) as SQL;

  async function row(id: string, tenantId: string, includeExpired = false): Promise<ArtifactRow | undefined> {
    if (!UUID_RE.test(id)) return undefined;
    const where = includeExpired ? eq(artifacts.id, id) : (and(eq(artifacts.id, id), notExpired()) as SQL);
    return tenantScoped(db, tenantId).first(artifacts, where);
  }

  async function removeBlob(url: string, id: string): Promise<void> {
    try {
      await blob.del(url);
    } catch (err) {
      logger.error("Artifact blob delete failed", COMPONENT, {
        errorMessage: `${id}: ${err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)}`,
      });
      throw err;
    }
  }

  async function purgeRow(r: Pick<ArtifactRow, "id" | "tenantId" | "blobUrl">): Promise<void> {
    // Blob first: if it fails the row survives and the next run retries.
    await removeBlob(r.blobUrl, r.id);
    await tenantScoped(db, r.tenantId).delete(artifacts, eq(artifacts.id, r.id));
  }

  return {
    async put(input) {
      assertTenantId(input.tenantId);
      if (!input.userId) throw new Error("@neo/db: userId is required");
      if (!input.mimeType) throw new Error("@neo/db: mimeType is required");
      if (!(input.bytes instanceof Uint8Array)) throw new Error("@neo/db: bytes must be a Uint8Array");
      if (!masterKey && !plaintextAllowed) throw new ArtifactStoreUnavailableError();

      const id = randomUUID();
      const sha256 = createHash("sha256").update(input.bytes).digest("hex");
      const encrypted = masterKey !== undefined;
      const stored = encrypted ? encryptArtifact(deriveTenantKey(masterKey, input.tenantId), input.bytes, id) : input.bytes;
      const createdAt = now();
      const expiresAt = new Date(createdAt.getTime() + retentionDays * DAY_MS);

      const { url } = await blob.put(artifactBlobPath(input.tenantId, id), stored, "application/octet-stream");
      try {
        const [r] = await tenantScoped(db, input.tenantId).insert(artifacts, {
          id,
          userId: input.userId,
          kind: input.kind,
          filename: input.filename ?? null,
          mimeType: input.mimeType,
          source: input.source,
          blobUrl: url,
          sha256,
          sizeBytes: input.bytes.byteLength,
          encrypted,
          createdAt,
          expiresAt,
        });
        if (!r) throw new Error("@neo/db: artifact insert returned no row");
        return toMeta(r);
      } catch (err) {
        await blob.del(url).catch(() => undefined);
        throw err;
      }
    },

    async get(id, tenantId) {
      const r = await row(id, tenantId);
      return r ? toMeta(r) : undefined;
    },

    async read(id, tenantId) {
      const r = await row(id, tenantId);
      if (!r) return undefined;
      const bytes = await blob.get(r.blobUrl);
      if (!bytes) return undefined;
      if (!r.encrypted) return bytes;
      if (!masterKey) throw new ArtifactStoreUnavailableError("artifact is encrypted but NEO_MASTER_KEY is unset");
      return decryptArtifact(deriveTenantKey(masterKey, r.tenantId), bytes, r.id);
    },

    async delete(id, tenantId) {
      const r = await row(id, tenantId, true);
      if (r) await purgeRow(r);
    },

    async listExpired(limit) {
      const max = Math.max(0, Math.min(Math.floor(limit), 1000));
      if (max === 0) return [];
      // Security-definer function: works under the app role (RLS) as well as the owner.
      const res = await db.execute<{ id: string; tenant_id: string }>(sql`select id, tenant_id from list_expired_artifacts(${max})`);
      const pairs = (res as unknown as { rows: Array<{ id: string; tenant_id: string }> }).rows;
      const out: ArtifactMeta[] = [];
      for (const p of pairs) {
        const r = await row(p.id, p.tenant_id, true);
        if (r) out.push(toMeta(r));
      }
      return out;
    },

    async purge(id, tenantId) {
      if (!UUID_RE.test(id)) return;
      if (tenantId) {
        const r = await row(id, tenantId, true);
        if (r) await purgeRow(r);
        return;
      }
      // Owner role only (RLS hides the row from the app role without a tenant context).
      const [r] = await db
        .select({ id: artifacts.id, tenantId: artifacts.tenantId, blobUrl: artifacts.blobUrl })
        .from(artifacts)
        .where(eq(artifacts.id, id))
        .limit(1);
      if (r) await purgeRow(r);
    },
  };
}
