/**
 * Per-household monthly model spend cap (_specs/v2-m3-cutover.md section 6). Off by default (`null`).
 * Postgres via `spend` from @neo/db when DATABASE_URL is set; otherwise an in-memory twin over the
 * no-database usage rows, so the cap is testable in MOCK_MODE.
 *
 * - `spendGate` is the chat pre-flight: blocked from 100% of the cap. Chat only. Background jobs (forwarded-email
 *   triage, device signals) never call it, so security alerts keep working when the cap is reached.
 * - `evaluateSpendCap` raises the templated `spend_cap` alerts (80% medium, 100% high), once per household month each.
 * Both throw when the usage store is unavailable: the chat callers fail closed.
 */
import { estimateCostCents, monthWindow, spendLevel, type SpendLevel } from "@neo/core";
import { spend } from "@neo/db";
import { alertSpendCap } from "./alerts";
import { getDb } from "./db";
import { memoryHouseholdTimeZone } from "./memory-members";
import { memoryUsageEvents } from "./usage";

export interface SpendView {
  capCents: number | null;
  timeZone: string | null;
  /** Estimated month-to-date model spend in cents (fractional). */
  spentCents: number;
  /** spent / cap, as a percentage; null while the cap is off. */
  percent: number | null;
  level: SpendLevel;
  /** `YYYY-MM` of the household-time-zone month. */
  month: string;
  /** Start of next month in the household's time zone: when the spend counter resets. */
  resetAt: Date;
}

const g = globalThis as typeof globalThis & { __neoMemorySpendCaps?: Map<string, number> };

function memoryCaps(): Map<string, number> {
  g.__neoMemorySpendCaps ??= new Map();
  return g.__neoMemorySpendCaps;
}

function memorySpentCents(tenantId: string, start: Date, end: Date): number {
  let total = 0;
  for (const e of memoryUsageEvents()) {
    if (e.tenantId !== tenantId || e.createdAt < start || e.createdAt >= end) continue;
    total += estimateCostCents({
      model: e.model,
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      cacheReadTokens: e.cacheReadTokens ?? 0,
      cacheCreationTokens: e.cacheCreationTokens ?? 0,
    });
  }
  return total;
}

/** The cap and time zone only (one cheap read), so a household with the cap off never pays for the spend query. */
async function settingsOf(tenantId: string): Promise<{ capCents: number | null; timeZone: string | null }> {
  const db = getDb();
  if (!db) return { capCents: memoryCaps().get(tenantId) ?? null, timeZone: memoryHouseholdTimeZone(tenantId) };
  const row = await spend.getSpendSettings(db, tenantId);
  return row ?? { capCents: null, timeZone: null };
}

async function spentIn(tenantId: string, window: { start: Date; end: Date }): Promise<number> {
  const db = getDb();
  return db ? spend.monthSpendCents(db, tenantId, window) : memorySpentCents(tenantId, window.start, window.end);
}

/** Cap, month-to-date spend and level, for the settings page and the gate. */
export async function spendView(tenantId: string, now: Date = new Date()): Promise<SpendView> {
  const settings = await settingsOf(tenantId);
  const window = monthWindow(now, settings.timeZone);
  const spentCents = await spentIn(tenantId, window);
  return {
    ...settings,
    spentCents,
    percent: settings.capCents === null ? null : (spentCents / settings.capCents) * 100,
    level: spendLevel(spentCents, settings.capCents),
    month: window.month,
    resetAt: window.end,
  };
}

/** Set (cents) or clear (null) the cap. The value is validated by the caller (`isValidSpendCapCents`). */
export async function setSpendCapCents(tenantId: string, capCents: number | null): Promise<void> {
  const db = getDb();
  if (db) {
    if (!(await spend.setSpendCap(db, tenantId, capCents))) throw new Error("unknown household");
    return;
  }
  if (capCents === null) memoryCaps().delete(tenantId);
  else memoryCaps().set(tenantId, capCents);
}

/**
 * Alert at 80% and at 100% of the cap (each once per household month, through the alert dedupe key). Returns the view,
 * or null while the cap is off (nothing is computed then). Raising never throws; reading the usage store may.
 */
export async function evaluateSpendCap(tenantId: string, now: Date = new Date()): Promise<SpendView | null> {
  const settings = await settingsOf(tenantId);
  if (settings.capCents === null) return null;
  const view = await spendView(tenantId, now);
  if (view.capCents === null) return null;
  const input = { tenantId, month: view.month, spentCents: view.spentCents, capCents: view.capCents };
  if (view.level === "warn" || view.level === "blocked") await alertSpendCap({ ...input, percent: 80 });
  if (view.level === "blocked") await alertSpendCap({ ...input, percent: 100 });
  return view;
}

export type SpendGate = { blocked: false } | { blocked: true; message: string; resetAt: Date; capCents: number };

/** The one friendly sentence shown when chat is refused at the cap (the old chat's 429 body, the eve chat's templated reply). */
export function spendCapMessage(resetAt: Date, timeZone: string | null): string {
  let zone = timeZone ?? "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    zone = "UTC";
  }
  const date = resetAt.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: zone });
  return `Your household has reached its monthly AI spend limit, so chat is paused until ${date}. An owner can raise the limit in household settings. Neo still checks forwarded email and device alerts.`;
}

/** The chat pre-flight: alerts as the spend crosses 80% / 100%, and blocks from 100%. Throws when the usage store is down (fail closed). */
export async function spendGate(tenantId: string, now: Date = new Date()): Promise<SpendGate> {
  const view = await evaluateSpendCap(tenantId, now);
  if (!view || view.level !== "blocked" || view.capCents === null) return { blocked: false };
  return { blocked: true, message: spendCapMessage(view.resetAt, view.timeZone), resetAt: view.resetAt, capCents: view.capCents };
}

/** 429 for the old chat when the household's monthly spend cap is reached. */
export function spendCapExceededResponse(gate: Extract<SpendGate, { blocked: true }>, now: Date = new Date()): Response {
  const retryAfter = Math.max(1, Math.ceil((gate.resetAt.getTime() - now.getTime()) / 1000));
  return Response.json(
    { error: "spend_cap_exceeded", limitCents: gate.capCents, resetAt: gate.resetAt.toISOString(), message: gate.message },
    { status: 429, headers: { "Retry-After": String(retryAfter), "Cache-Control": "no-store" } },
  );
}
