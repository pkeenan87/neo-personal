/**
 * Model spend maths for the per-household monthly spend cap (_specs/v2-m3-cutover.md section 6):
 * token usage to cents, the household-time-zone month window, and the 80% / 100% thresholds.
 * Pure: no I/O, so the web app and `@neo/db` share one definition.
 */
import { MODEL_CATALOG, MODEL_FAMILIES, TIERS, catalogEntryFor } from "./routing.js";

/** Cache reads bill at 0.1x the input price and cache writes at 1.25x (Anthropic prompt-caching rates; other families are estimated the same way). */
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER = 1.25;

export interface SpendTokens {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** The dearest catalog model (USD per million tokens), used for a model id the catalog does not know: over-count rather than miss spend. */
function dearestPricing(): { input: number; output: number } {
  let best = { input: 0, output: 0 };
  for (const f of MODEL_FAMILIES) {
    for (const t of TIERS) {
      const p = MODEL_CATALOG[f][t].pricing;
      if (p.output > best.output || (p.output === best.output && p.input > best.input)) best = p;
    }
  }
  return best;
}

/**
 * Estimated cost in cents (fractional) of one group of usage rows. Prices are the catalog's `pricing`
 * (USD per million tokens, the gateway's global rate), so the figure is an estimate: a gateway fallback,
 * discounts or provider-side rounding are not visible in `usage_events`.
 */
export function estimateCostCents(u: SpendTokens): number {
  const p = catalogEntryFor(u.model)?.pricing ?? dearestPricing();
  const usd =
    (u.inputTokens * p.input +
      u.outputTokens * p.output +
      u.cacheReadTokens * p.input * CACHE_READ_MULTIPLIER +
      u.cacheCreationTokens * p.input * CACHE_WRITE_MULTIPLIER) /
    1_000_000;
  return usd * 100;
}

export interface MonthWindow {
  /** Inclusive start (the household's local midnight on the 1st), as an instant. */
  start: Date;
  /** Exclusive end (local midnight on the 1st of next month). */
  end: Date;
  /** `YYYY-MM` of the local month, for dedupe keys. */
  month: string;
}

function validZone(timeZone: string | null | undefined): string {
  if (!timeZone) return "UTC";
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

/** Offset in ms of `timeZone` from UTC at `instant` (positive = ahead of UTC). */
function offsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(instant));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** The instant of local midnight on the 1st of (`year`, `month0`) in `timeZone`. */
function startOfLocalMonth(year: number, month0: number, timeZone: string): number {
  const guess = Date.UTC(year, month0, 1);
  const first = guess - offsetMs(guess, timeZone);
  return guess - offsetMs(first, timeZone);
}

/** The calendar month containing `now` in the household's time zone (null or unknown reads as UTC). */
export function monthWindow(now: Date, timeZone: string | null | undefined): MonthWindow {
  const zone = validZone(timeZone);
  const local = new Date(now.getTime() + offsetMs(now.getTime(), zone));
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  return {
    start: new Date(startOfLocalMonth(y, m, zone)),
    end: new Date(startOfLocalMonth(y, m + 1, zone)),
    month: `${y}-${String(m + 1).padStart(2, "0")}`,
  };
}

export const SPEND_CAP_MIN_CENTS = 100;
export const SPEND_CAP_MAX_CENTS = 1_000_000;

/** A valid cap: an integer number of cents from $1.00 to $10,000.00. */
export function isValidSpendCapCents(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= SPEND_CAP_MIN_CENTS && n <= SPEND_CAP_MAX_CENTS;
}

export type SpendLevel = "ok" | "warn" | "blocked";

/** `warn` from 80% of the cap, `blocked` from 100%. A null cap is always `ok` (the cap is off). */
export function spendLevel(spentCents: number, capCents: number | null): SpendLevel {
  if (capCents === null) return "ok";
  if (spentCents >= capCents) return "blocked";
  if (spentCents >= capCents * 0.8) return "warn";
  return "ok";
}
