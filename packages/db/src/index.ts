import * as schema from "./schema/index.js";

export { schema };
export * from "./schema/index.js";

export { createDb, selectDriver, type Db, type DbDriver, type Schema, type Tx } from "./client.js";
export {
  tenantScoped,
  tenantTables,
  assertTenantId,
  setTenantContext,
  setUserContext,
  type TenantDb,
  type TenantQueries,
  type TenantTable,
  type TenantTx,
} from "./tenant.js";
export { createConversationStore } from "./conversation-store.js";
export {
  usage,
  getUsageCaps,
  parseIntEnv,
  utcWindows,
  DEFAULT_DAILY_TOKENS,
  DEFAULT_MONTHLY_CHECKS,
  type CapCheckResult,
  type CapHitInput,
  type CapReason,
  type RecordCheckInput,
  type UsageCaps,
} from "./usage.js";
export { createTenantForUser, findTenantForUser, getHouseholdName, type UserTenant } from "./tenants.js";
export { createMemoryBlobClient, createVercelBlobClient, type BlobClient } from "./blob.js";
export {
  ArtifactStoreUnavailableError,
  DEFAULT_ARTIFACT_RETENTION_DAYS,
  artifactBlobPath,
  artifactRetentionDays,
  createArtifactStore,
  type ArtifactMeta,
  type ArtifactStore,
  type ArtifactStoreOptions,
  type PutArtifactInput,
} from "./artifact-store.js";
export {
  generateLocalPart,
  inbound,
  inboundAddressFor,
  isInboundLocalPart,
  type InboundAddress,
  type InboundMessagePatch,
  type InboundMessageRow,
  type RecordMessageInput,
} from "./inbound.js";
export {
  InvalidCursorError,
  decodeVerdictCursor,
  encodeVerdictCursor,
  listMembers,
  saveVerdict,
  verdictQueries,
  type HouseholdMember,
  type SaveVerdictInput,
  type VerdictListOptions,
  type VerdictRow,
  type VerdictSummary,
} from "./verdicts.js";
// runMigrations lives in the "@neo/db/migrate" subpath so app bundles never see the migrations folder.
export type { ConversationStore, MessageParam } from "@neo/core";
