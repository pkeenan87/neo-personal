import { bigint, boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { tenants } from "./tenants.js";

/** Raw user-supplied evidence (.eml, screenshots) stored in Vercel Blob. */
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
    kind: text("kind").notNull(),
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
  ],
);
