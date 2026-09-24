/**
 * Per-tenant usage caps (_specs/usage-caps.md). Postgres via `usage` from
 * @neo/db when DATABASE_URL is set; otherwise an in-memory fallback with the
 * same semantics so caps are testable in MOCK_MODE with no database.
 */
import { hashPii, logger } from "@neo/core";
import { getUsageCaps, usage, utcWindows, type CapCheckResult, type CapReason, type RecordCheckInput } from "@neo/db";
import { recordAudit } from "./audit";
import { getDb } from "./db";

export type { CapCheckResult, CapReason, RecordCheckInput };

interface MemoryUsageEvent extends RecordCheckInput {
  createdAt: Date;
}

const g = globalThis as typeof globalThis & {
  __neoMemoryUsage?: MemoryUsageEvent[];
  __neoMemoryCapHits?: Set<string>;
};

function memoryEvents(): MemoryUsageEvent[] {
  g.__neoMemoryUsage ??= [];
  return g.__neoMemoryUsage;
}

/** Test helper: clear the no-database usage fallback. */
export function resetMemoryUsage(): void {
  g.__neoMemoryUsage = [];
  g.__neoMemoryCapHits = new Set();
}

function memoryCheckCaps(tenantId: string, now = new Date()): CapCheckResult {
  const limits = getUsageCaps();
  const w = utcWindows(now);
  let monthlyChecks = 0;
  let dailyTokens = 0;
  for (const e of memoryEvents()) {
    if (e.tenantId !== tenantId) continue;
    if ((e.kind ?? "check") === "check" && e.createdAt >= w.monthStart && e.createdAt < w.monthEnd) monthlyChecks++;
    if (e.createdAt >= w.dayStart && e.createdAt < w.dayEnd) dailyTokens += e.inputTokens + e.outputTokens;
  }
  const used = { monthlyChecks, dailyTokens };
  const remaining = {
    monthlyChecks: Math.max(0, limits.monthlyChecks - monthlyChecks),
    dailyTokens: Math.max(0, limits.dailyTokens - dailyTokens),
  };
  const resetAt = { monthlyChecks: w.monthEnd, dailyTokens: w.dayEnd };
  if (monthlyChecks >= limits.monthlyChecks) return { allowed: false, reason: "monthly_checks", remaining, used, limits, resetAt };
  if (dailyTokens >= limits.dailyTokens) return { allowed: false, reason: "daily_tokens", remaining, used, limits, resetAt };
  return { allowed: true, remaining, used, limits, resetAt };
}

/** Throws when the usage store is unavailable: callers fail closed (503). */
export async function checkCaps(tenantId: string): Promise<CapCheckResult> {
  const db = getDb();
  return db ? usage.checkCaps(db, tenantId) : memoryCheckCaps(tenantId);
}

/** Record one agent run. Never throws: a recording failure must not break the response. */
export async function recordUsage(input: RecordCheckInput): Promise<void> {
  try {
    const db = getDb();
    if (db) await usage.recordCheck(db, input);
    else memoryEvents().push({ ...input, createdAt: new Date() });
  } catch (err) {
    logger.error("Usage recording failed", "usage", {
      tenantId: input.tenantId,
      userIdHash: hashPii(input.userId),
      conversationId: input.conversationId,
      model: input.model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      errorMessage: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
    });
  }
}

export function capLimit(caps: CapCheckResult, reason: CapReason): number {
  return reason === "monthly_checks" ? caps.limits.monthlyChecks : caps.limits.dailyTokens;
}

export function capResetAt(caps: CapCheckResult, reason: CapReason): Date {
  return reason === "monthly_checks" ? caps.resetAt.monthlyChecks : caps.resetAt.dailyTokens;
}

/**
 * Log the cap hit and write at most one `usage.cap_hit` audit event per
 * tenant, reason and period. Never throws.
 */
export async function noteCapHit(tenantId: string, userId: string, caps: CapCheckResult, reason: CapReason): Promise<void> {
  const limit = capLimit(caps, reason);
  const used = reason === "monthly_checks" ? caps.used.monthlyChecks : caps.used.dailyTokens;
  const resetAt = capResetAt(caps, reason);
  logger.warn("usage_cap_hit", "usage", { tenantId, userIdHash: hashPii(userId), reason, limit, used });
  try {
    const db = getDb();
    if (db) {
      await usage.recordCapHit(db, { tenantId, userId, reason, limit, used, resetAt });
      return;
    }
    const w = utcWindows(new Date());
    const key = `${tenantId}:${reason}:${(reason === "monthly_checks" ? w.monthStart : w.dayStart).toISOString()}`;
    g.__neoMemoryCapHits ??= new Set();
    if (g.__neoMemoryCapHits.has(key)) return;
    g.__neoMemoryCapHits.add(key);
    await recordAudit(tenantId, userId, "usage.cap_hit", { reason, limit, used, resetAt: resetAt.toISOString() });
  } catch (err) {
    logger.error("usage.cap_hit audit failed", "usage", {
      tenantId,
      reason,
      errorMessage: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
    });
  }
}

/** 429 response body and headers for a denied cap check (_specs/usage-caps.md). */
export function capExceededResponse(caps: CapCheckResult, reason: CapReason, now = new Date()): Response {
  const resetAt = capResetAt(caps, reason);
  const retryAfter = Math.max(1, Math.ceil((resetAt.getTime() - now.getTime()) / 1000));
  const message =
    reason === "monthly_checks"
      ? `Your household has used all of this month's free checks. They reset on ${resetAt.toLocaleDateString("en-US", {
          month: "long",
          day: "numeric",
          timeZone: "UTC",
        })}.`
      : "Your household has hit today's usage limit. It resets at midnight UTC.";
  return Response.json(
    { error: "usage_cap_exceeded", reason, limit: capLimit(caps, reason), resetAt: resetAt.toISOString(), message },
    { status: 429, headers: { "Retry-After": String(retryAfter), "Cache-Control": "no-store" } },
  );
}

/** GET /api/usage body. */
export function usageSummary(caps: CapCheckResult) {
  return {
    monthlyChecks: {
      used: caps.used.monthlyChecks,
      limit: caps.limits.monthlyChecks,
      resetAt: caps.resetAt.monthlyChecks.toISOString(),
    },
    dailyTokens: {
      used: caps.used.dailyTokens,
      limit: caps.limits.dailyTokens,
      resetAt: caps.resetAt.dailyTokens.toISOString(),
    },
  };
}
