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
export { createTenantForUser, findTenantForUser, type UserTenant } from "./tenants.js";
// runMigrations lives in the "@neo/db/migrate" subpath so app bundles never see the migrations folder.
export type { ConversationStore, MessageParam } from "@neo/core";
