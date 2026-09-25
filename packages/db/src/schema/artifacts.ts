import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { tenants } from "./tenants.js";

export const ARTIFACT_KINDS = ["eml", "image", "text", "inbound_eml"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export const ARTIFACT_SOURCES = ["upload", "inbound"] as const;
export type ArtifactSource = (typeof ARTIFACT_SOURCES)[number];

/**
 * Raw user-supplied evidence (.eml, screenshots) stored in Vercel Blob, encrypted with a
 * per-tenant key (see createArtifactStore). The row holds metadata only.
 */
export const artifacts = pgTable(
  "artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").$type<ArtifactKind>().notNull(),
    /** Original file name as supplied by the user (untrusted; display only). */
    filename: text("filename"),
    /** Media type of the plaintext (the blob itself is application/octet-stream ciphertext). */
    mimeType: text("mime_type").notNull(),
    source: text("source").$type<ArtifactSource>().notNull().default("upload"),
    blobUrl: text("blob_url").notNull(),
    sha256: text("sha256").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    encrypted: boolean("encrypted").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
    /** Retention: raw artifacts default to 30 days; null means keep. */
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }),
  },
  (t) => [
    index("artifacts_tenant_created_idx").on(t.tenantId, t.createdAt.desc()),
    index("artifacts_expires_idx").on(t.expiresAt),
    index("artifacts_tenant_sha256_idx").on(t.tenantId, t.sha256),
    check("artifacts_source_check", sql`${t.source} in ('upload', 'inbound')`),
  ],
);
