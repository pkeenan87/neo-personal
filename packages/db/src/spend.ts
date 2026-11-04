/**
 * Per-household monthly model spend cap (_specs/v2-m3-cutover.md section 6). The cap lives on
 * `tenants.monthly_spend_cap_cents` (null = off); month-to-date spend is estimated from `usage_events`
 * (tokens x the catalog price of the model), over the month in the household's time zone.
 */
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { estimateCostCents, isValidSpendCapCents, monthWindow, spendLevel, type MonthWindow, type SpendLevel } from "@neo/core";
import type { Db } from "./client.js";
import { tenants, usageEvents } from "./schema/index.js";
import { assertTenantId, tenantScoped } from "./tenant.js";

export interface SpendSettings {
  capCents: number | null;
  timeZone: string | null;
}

export interface SpendStatus extends SpendSettings {
  /** Estimated month-to-date model spend in cents (fractional). */
  spentCents: number;
  /** spent / cap as a percentage, or null while the cap is off. */
  percent: number | null;
  level: SpendLevel;
  window: MonthWindow;
}

/** The household's cap and time zone; undefined for an unknown tenant. */
async function getSpendSettings(db: Db, tenantId: string): Promise<SpendSettings | undefined> {
  assertTenantId(tenantId);
  const [row] = await tenantScoped(db, tenantId).transaction((t) =>
    t.tx
      .select({ capCents: tenants.monthlySpendCapCents, timeZone: tenants.timeZone })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1),
  );
  return row;
}

/** Set (cents) or clear (null) the cap. Throws on a value outside $1.00 to $10,000.00; false for an unknown tenant. */
async function setSpendCap(db: Db, tenantId: string, capCents: number | null): Promise<boolean> {
  assertTenantId(tenantId);
  if (capCents !== null && !isValidSpendCapCents(capCents)) throw new Error("@neo/db: invalid spend cap");
  const rows = await tenantScoped(db, tenantId).transaction((t) =>
    t.tx.update(tenants).set({ monthlySpendCapCents: capCents }).where(eq(tenants.id, tenantId)).returning({ id: tenants.id }),
  );
  return rows.length > 0;
}

/** Estimated model spend in cents over [window.start, window.end), all usage kinds (checks, resumptions, background triage). */
async function monthSpendCents(db: Db, tenantId: string, window: Pick<MonthWindow, "start" | "end">): Promise<number> {
  assertTenantId(tenantId);
  const rows = await tenantScoped(db, tenantId).transaction((t) =>
    t.tx
      .select({
        model: usageEvents.model,
        input: sql<string>`coalesce(sum(${usageEvents.inputTokens}::bigint), 0)`,
        output: sql<string>`coalesce(sum(${usageEvents.outputTokens}::bigint), 0)`,
        cacheRead: sql<string>`coalesce(sum(${usageEvents.cacheReadTokens}::bigint), 0)`,
        cacheWrite: sql<string>`coalesce(sum(${usageEvents.cacheCreationTokens}::bigint), 0)`,
      })
      .from(usageEvents)
      .where(and(eq(usageEvents.tenantId, tenantId), gte(usageEvents.createdAt, window.start), lt(usageEvents.createdAt, window.end)))
      .groupBy(usageEvents.model),
  );
  return rows.reduce(
    (sum, r) =>
      sum +
      estimateCostCents({
        model: r.model,
        inputTokens: Number(r.input),
        outputTokens: Number(r.output),
        cacheReadTokens: Number(r.cacheRead),
        cacheCreationTokens: Number(r.cacheWrite),
      }),
    0,
  );
}

/** Cap, month-to-date spend and level for one household; undefined for an unknown tenant. */
async function spendStatus(db: Db, tenantId: string, now: Date = new Date()): Promise<SpendStatus | undefined> {
  const settings = await getSpendSettings(db, tenantId);
  if (!settings) return undefined;
  const window = monthWindow(now, settings.timeZone);
  const spentCents = await monthSpendCents(db, tenantId, window);
  return {
    ...settings,
    spentCents,
    percent: settings.capCents === null ? null : (spentCents / settings.capCents) * 100,
    level: spendLevel(spentCents, settings.capCents),
    window,
  };
}

export const spend = { getSpendSettings, setSpendCap, monthSpendCents, spendStatus };
