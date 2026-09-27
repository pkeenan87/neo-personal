import { and, count, eq, sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { MODEL_FAMILIES, ROUTING_PREFERENCES, type ModelFamily, type RoutingPreference } from "@neo/core";
import type { Db, Tx } from "./client.js";
import {
  artifacts,
  auditEvents,
  conversations,
  alerts,
  householdInvites,
  inboundAddresses,
  inboundMessages,
  memberships,
  turns,
  usageEvents,
  verdicts,
} from "./schema/index.js";

/** Tables owned by a tenant (carry a non-null `tenant_id`). */
export const tenantTables = {
  memberships,
  conversations,
  turns,
  verdicts,
  artifacts,
  auditEvents,
  usageEvents,
  inboundAddresses,
  inboundMessages,
  householdInvites,
  alerts,
} as const;

/** Any table with a `tenantId` column. */
export type TenantTable = PgTable & { tenantId: PgColumn };
type Row<T extends TenantTable> = T["$inferSelect"];
type NewRow<T extends TenantTable> = Omit<T["$inferInsert"], "tenantId">;
type Patch<T extends TenantTable> = { [K in keyof Omit<T["$inferInsert"], "tenantId">]?: T["$inferInsert"][K] | SQL };

/** Query helpers bound to one tenant. Every helper adds `tenant_id = :tenantId`. */
export interface TenantQueries {
  readonly tenantId: string;
  /** SELECT * FROM table WHERE tenant_id = :tenantId [AND where] [ORDER BY ...] [LIMIT n] */
  select<T extends TenantTable>(table: T, where?: SQL, opts?: { orderBy?: SQL[]; limit?: number }): Promise<Row<T>[]>;
  /** First matching row or undefined. */
  first<T extends TenantTable>(table: T, where?: SQL, opts?: { orderBy?: SQL[] }): Promise<Row<T> | undefined>;
  /** INSERT with `tenant_id` forced to :tenantId (any tenantId in values is ignored). */
  insert<T extends TenantTable>(table: T, values: NewRow<T> | NewRow<T>[]): Promise<Row<T>[]>;
  /** UPDATE ... WHERE tenant_id = :tenantId [AND where]. `tenantId` cannot be changed. */
  update<T extends TenantTable>(table: T, set: Patch<T>, where?: SQL): Promise<Row<T>[]>;
  /** DELETE ... WHERE tenant_id = :tenantId [AND where]. */
  delete<T extends TenantTable>(table: T, where?: SQL): Promise<Row<T>[]>;
  /** SELECT count(*) ... WHERE tenant_id = :tenantId [AND where]. */
  count<T extends TenantTable>(table: T, where?: SQL): Promise<number>;
}

/** A transaction scoped to one tenant: helpers plus the raw Drizzle transaction. */
export interface TenantTx extends TenantQueries {
  /**
   * Raw transaction (app.tenant_id already set, so RLS applies). Queries written against
   * `tx` directly must still filter on tenant_id themselves.
   */
  readonly tx: Tx;
}

/** A member's model routing settings (Phase 2). Stored on their `memberships` row. */
export interface MemberPreferences {
  routingPreference: RoutingPreference;
  modelFamily: ModelFamily;
}

export const DEFAULT_MEMBER_PREFERENCES: Readonly<MemberPreferences> = Object.freeze({
  routingPreference: "balanced",
  modelFamily: "anthropic",
});

/** Membership helpers bound to one tenant. */
export interface TenantMemberships {
  /** The member's routing preferences; defaults when the user has no membership row in this tenant. */
  getPreferences(userId: string): Promise<MemberPreferences>;
  /**
   * Update the member's own row in this tenant (only the fields in `patch`) and return the
   * stored result. Throws on an unknown value or when the user is not a member of the tenant.
   */
  setPreferences(userId: string, patch: Partial<MemberPreferences>): Promise<MemberPreferences>;
}

export interface TenantDb extends TenantQueries {
  /** Run several statements in one transaction with app.tenant_id set once. */
  transaction<R>(fn: (t: TenantTx) => Promise<R>): Promise<R>;
  readonly memberships: TenantMemberships;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertTenantId(tenantId: string): void {
  if (typeof tenantId !== "string" || !UUID_RE.test(tenantId)) {
    throw new Error("@neo/db: tenantId must be a UUID");
  }
}

/** Set transaction-local RLS context. Must run inside a transaction. */
export async function setTenantContext(tx: Tx, tenantId: string): Promise<void> {
  await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
}

/** Set transaction-local user context (used by the memberships self-read policy). */
export async function setUserContext(tx: Tx, userId: string): Promise<void> {
  await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
}

function scopeWhere(table: TenantTable, tenantId: string, where?: SQL): SQL {
  const tenantEq = eq(table.tenantId, tenantId);
  return where ? (and(tenantEq, where) as SQL) : tenantEq;
}

function bindQueries(tx: Tx, tenantId: string): TenantQueries {
  // Drizzle's builder types do not survive a generic `T extends PgTable`; rows are typed by
  // the public signatures above, so the internals work on the erased table type.
  const q = {
    tenantId,
    async select(table: TenantTable, where?: SQL, opts?: { orderBy?: SQL[]; limit?: number }) {
      const base = tx.select().from(table).where(scopeWhere(table, tenantId, where)).$dynamic();
      if (opts?.orderBy?.length) base.orderBy(...opts.orderBy);
      if (opts?.limit !== undefined) base.limit(opts.limit);
      return base;
    },
    async first(table: TenantTable, where?: SQL, opts?: { orderBy?: SQL[] }) {
      const rows = await q.select(table, where, { ...opts, limit: 1 });
      return rows[0];
    },
    async insert(table: TenantTable, values: Record<string, unknown> | Record<string, unknown>[]) {
      const list = (Array.isArray(values) ? values : [values]).map((v) => ({ ...v, tenantId }));
      if (list.length === 0) return [];
      return tx.insert(table).values(list as never).returning();
    },
    async update(table: TenantTable, set: Record<string, unknown>, where?: SQL) {
      const patch: Record<string, unknown> = { ...set };
      delete patch.tenantId;
      return tx.update(table).set(patch as never).where(scopeWhere(table, tenantId, where)).returning();
    },
    async delete(table: TenantTable, where?: SQL) {
      return tx.delete(table).where(scopeWhere(table, tenantId, where)).returning();
    },
    async count(table: TenantTable, where?: SQL) {
      const [row] = await tx.select({ n: count() }).from(table).where(scopeWhere(table, tenantId, where));
      return row?.n ?? 0;
    },
  };
  return q as unknown as TenantQueries;
}

/** Stored values are constrained by check constraints; anything unexpected reads as the default. */
function preferencesOf(row: { routingPreference: string; modelFamily: string }): MemberPreferences {
  return {
    routingPreference: (ROUTING_PREFERENCES as readonly string[]).includes(row.routingPreference)
      ? (row.routingPreference as RoutingPreference)
      : DEFAULT_MEMBER_PREFERENCES.routingPreference,
    modelFamily: (MODEL_FAMILIES as readonly string[]).includes(row.modelFamily)
      ? (row.modelFamily as ModelFamily)
      : DEFAULT_MEMBER_PREFERENCES.modelFamily,
  };
}

/**
 * Tenant-scoped access. Every method runs in its own transaction that first executes
 * `SELECT set_config('app.tenant_id', $1, true)` (so RLS policies apply), and every query
 * helper adds `eq(table.tenantId, tenantId)`.
 */
export function tenantScoped(db: Db, tenantId: string): TenantDb {
  assertTenantId(tenantId);

  const transaction = <R>(fn: (t: TenantTx) => Promise<R>): Promise<R> =>
    db.transaction(async (tx) => {
      await setTenantContext(tx, tenantId);
      return fn({ ...bindQueries(tx, tenantId), tx });
    });

  const once =
    <K extends keyof Omit<TenantQueries, "tenantId">>(key: K) =>
    (...args: unknown[]) =>
      transaction((t) => (t[key] as (...a: unknown[]) => Promise<unknown>)(...args));

  const memberQueries: TenantMemberships = {
    async getPreferences(userId) {
      const row = await transaction((t) => t.first(memberships, eq(memberships.userId, userId)));
      return row ? preferencesOf(row) : { ...DEFAULT_MEMBER_PREFERENCES };
    },
    async setPreferences(userId, patch) {
      const set: { routingPreference?: RoutingPreference; modelFamily?: ModelFamily } = {};
      if (patch.routingPreference !== undefined) {
        if (!ROUTING_PREFERENCES.includes(patch.routingPreference)) throw new Error("@neo/db: unknown routing preference");
        set.routingPreference = patch.routingPreference;
      }
      if (patch.modelFamily !== undefined) {
        if (!MODEL_FAMILIES.includes(patch.modelFamily)) throw new Error("@neo/db: unknown model family");
        set.modelFamily = patch.modelFamily;
      }
      const row = await transaction(async (t) => {
        const where = eq(memberships.userId, userId);
        if (Object.keys(set).length === 0) return t.first(memberships, where);
        const [updated] = await t.update(memberships, set, where);
        return updated;
      });
      if (!row) throw new Error("@neo/db: membership not found");
      return preferencesOf(row);
    },
  };

  return {
    tenantId,
    transaction,
    memberships: memberQueries,
    select: once("select"),
    first: once("first"),
    insert: once("insert"),
    update: once("update"),
    delete: once("delete"),
    count: once("count"),
  } as TenantDb;
}
