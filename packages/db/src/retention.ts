/**
 * Per-household data retention (_specs/v2-m4-hardening.md section 1). The settings live on `tenants`
 * (`retention_*_days`, null = the default, like the spend cap); the nightly purges are security-definer functions that join
 * `tenants` and use each household's value (migration 0030). `previewRetention` is the read-only twin for the shadow run.
 */
import { eq, sql } from "drizzle-orm";
import { DEFAULT_RETENTION, RETENTION_KINDS, isValidRetentionDays, type RetentionKind, type RetentionSettings } from "@neo/core";
import type { Db } from "./client.js";
import { tenants } from "./schema/index.js";
import { assertTenantId, tenantScoped } from "./tenant.js";

/** Days per kind; null = the default. */
export type StoredRetention = Record<RetentionKind, number | null>;

const COLUMN = {
  signals: "retentionSignalsDays",
  incidents: "retentionIncidentsDays",
  childRequests: "retentionChildRequestsDays",
  memory: "retentionMemoryDays",
} as const;

/** Fill the defaults in. */
export function effectiveRetention(stored: Partial<StoredRetention>): RetentionSettings {
  return {
    signals: stored.signals ?? DEFAULT_RETENTION.signals,
    incidents: stored.incidents ?? DEFAULT_RETENTION.incidents,
    childRequests: stored.childRequests ?? DEFAULT_RETENTION.childRequests,
    memory: stored.memory ?? DEFAULT_RETENTION.memory,
  };
}

/** The household's stored settings; undefined for an unknown tenant. */
export async function getRetentionSettings(db: Db, tenantId: string): Promise<StoredRetention | undefined> {
  assertTenantId(tenantId);
  const [row] = await tenantScoped(db, tenantId).transaction((t) =>
    t.tx
      .select({
        signals: tenants.retentionSignalsDays,
        incidents: tenants.retentionIncidentsDays,
        childRequests: tenants.retentionChildRequestsDays,
        memory: tenants.retentionMemoryDays,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1),
  );
  return row;
}

/** Set the four values (each within its bounds; throws otherwise). False for an unknown tenant. */
export async function setRetentionSettings(db: Db, tenantId: string, values: RetentionSettings): Promise<boolean> {
  assertTenantId(tenantId);
  const set: Record<string, number> = {};
  for (const kind of RETENTION_KINDS) {
    if (!isValidRetentionDays(kind, values[kind])) throw new Error("@neo/db: invalid retention days");
    set[COLUMN[kind]] = values[kind];
  }
  const rows = await tenantScoped(db, tenantId).transaction((t) =>
    t.tx.update(tenants).set(set).where(eq(tenants.id, tenantId)).returning({ id: tenants.id }),
  );
  return rows.length > 0;
}

export interface RetentionPreview {
  signals: number;
  alerts: number;
  childRequests: number;
  householdMemory: number;
}

/** Rows the household-data purges would delete now, across households, honouring each one's settings. Deletes nothing. */
export async function previewRetention(db: Db, now = new Date()): Promise<RetentionPreview> {
  const res = await db.execute(sql`select kind, n from public.retention_preview(${now.toISOString()}::timestamptz)`);
  const out: RetentionPreview = { signals: 0, alerts: 0, childRequests: 0, householdMemory: 0 };
  for (const r of (res as unknown as { rows: Array<{ kind: string; n: number | string }> }).rows) {
    if (r.kind === "signals") out.signals = Number(r.n);
    else if (r.kind === "alerts") out.alerts = Number(r.n);
    else if (r.kind === "child_requests") out.childRequests = Number(r.n);
    else if (r.kind === "household_memory") out.householdMemory = Number(r.n);
  }
  return out;
}

/** Retention, across households (`purge_old_child_requests`): decided or expired requests older than each household's setting. Returns the count. */
export async function purgeOldChildRequests(db: Db, now = new Date()): Promise<number> {
  const res = await db.execute(sql`select public.purge_old_child_requests(${now.toISOString()}::timestamptz) as n`);
  return Number((res as unknown as { rows: Array<{ n: number | string }> }).rows[0]?.n ?? 0);
}
