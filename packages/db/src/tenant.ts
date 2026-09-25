import { and, count, eq, sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { Db, Tx } from "./client.js";
import {
  artifacts,
  auditEvents,
  conversations,
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

export interface TenantDb extends TenantQueries {
  /** Run several statements in one transaction with app.tenant_id set once. */
  transaction<R>(fn: (t: TenantTx) => Promise<R>): Promise<R>;
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

  return {
    tenantId,
    transaction,
    select: once("select"),
    first: once("first"),
    insert: once("insert"),
    update: once("update"),
    delete: once("delete"),
    count: once("count"),
  } as TenantDb;
}
