import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { usageEvents } from "./schema/index.js";
import { tenantScoped } from "./tenant.js";

export const DEFAULT_MONTHLY_CHECKS = 50;
export const DEFAULT_DAILY_TOKENS = 300_000;

/**
 * Parse a non-negative integer env var. Unset, blank, non-numeric, fractional, negative or
 * unsafe values fall back to `fallback`. `0` is honoured (a kill switch that blocks all checks).
 */
export function parseIntEnv(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const trimmed = value.trim().replace(/_/g, "");
  if (!/^\d+$/.test(trimmed)) return fallback;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : fallback;
}

export type UsageCaps = { monthlyChecks: number; dailyTokens: number };

/** Caps from `USAGE_CAP_MONTHLY_CHECKS` / `USAGE_CAP_DAILY_TOKENS`, read on every call (no deploy needed to change). */
export function getUsageCaps(env: NodeJS.ProcessEnv = process.env): UsageCaps {
  return {
    monthlyChecks: parseIntEnv(env.USAGE_CAP_MONTHLY_CHECKS, DEFAULT_MONTHLY_CHECKS),
    dailyTokens: parseIntEnv(env.USAGE_CAP_DAILY_TOKENS, DEFAULT_DAILY_TOKENS),
  };
}

export type CapCheckResult = {
  allowed: boolean;
  reason?: "monthly_checks" | "daily_tokens";
  remaining: { monthlyChecks: number; dailyTokens: number };
  used: { monthlyChecks: number; dailyTokens: number };
  limits: UsageCaps;
};

export type RecordCheckInput = {
  tenantId: string;
  userId: string;
  conversationId?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
};

/** [start, end) of the UTC calendar month and UTC day containing `now`. */
export function utcWindows(now: Date): { monthStart: Date; monthEnd: Date; dayStart: Date; dayEnd: Date } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  return {
    monthStart: new Date(Date.UTC(y, m, 1)),
    monthEnd: new Date(Date.UTC(y, m + 1, 1)),
    dayStart: new Date(Date.UTC(y, m, d)),
    dayEnd: new Date(Date.UTC(y, m, d + 1)),
  };
}

const nonNegInt = (n: number | undefined): number => (Number.isFinite(n) && (n as number) > 0 ? Math.floor(n as number) : 0);

async function checkCaps(
  db: Db,
  tenantId: string,
  opts: { now?: Date; caps?: Partial<UsageCaps> } = {},
): Promise<CapCheckResult> {
  const now = opts.now ?? new Date();
  const limits: UsageCaps = { ...getUsageCaps(), ...opts.caps };
  const w = utcWindows(now);

  const used = await tenantScoped(db, tenantId).transaction(async (t) => {
    const monthlyChecks = await t.count(
      usageEvents,
      and(gte(usageEvents.createdAt, w.monthStart), lt(usageEvents.createdAt, w.monthEnd)),
    );
    const [tokens] = await t.tx
      .select({
        n: sql<string>`coalesce(sum(${usageEvents.inputTokens}::bigint + ${usageEvents.outputTokens}::bigint), 0)`,
      })
      .from(usageEvents)
      .where(
        and(
          eq(usageEvents.tenantId, tenantId),
          gte(usageEvents.createdAt, w.dayStart),
          lt(usageEvents.createdAt, w.dayEnd),
        ),
      );
    return { monthlyChecks, dailyTokens: Number(tokens?.n ?? 0) };
  });

  const remaining = {
    monthlyChecks: Math.max(0, limits.monthlyChecks - used.monthlyChecks),
    dailyTokens: Math.max(0, limits.dailyTokens - used.dailyTokens),
  };
  if (used.monthlyChecks >= limits.monthlyChecks) {
    return { allowed: false, reason: "monthly_checks", remaining, used, limits };
  }
  if (used.dailyTokens >= limits.dailyTokens) {
    return { allowed: false, reason: "daily_tokens", remaining, used, limits };
  }
  return { allowed: true, remaining, used, limits };
}

async function recordCheck(db: Db, input: RecordCheckInput): Promise<void> {
  await tenantScoped(db, input.tenantId).insert(usageEvents, {
    userId: input.userId,
    conversationId: input.conversationId ?? null,
    model: input.model,
    inputTokens: nonNegInt(input.inputTokens),
    outputTokens: nonNegInt(input.outputTokens),
    cacheReadTokens: nonNegInt(input.cacheReadTokens),
    cacheCreationTokens: nonNegInt(input.cacheCreationTokens),
  });
}

/**
 * Per-tenant usage caps. Monthly checks = usage_events rows this UTC calendar month; daily
 * tokens = sum(input + output) today (UTC). A check is allowed while both are below the cap.
 */
export const usage = { checkCaps, recordCheck };
