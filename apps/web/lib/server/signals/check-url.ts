/**
 * POST /api/devices/check-url (_specs/browser-extension.md "On-demand check"): the
 * extension's right-click "Check this link" and popup "Check this page". Deterministic
 * (`analyzeUrl` + `classifyUrlAnalysis`), shares the reputation cache with chat and signal
 * escalations, but is never saved as a verdict, never raises an alert, and never counts
 * against the household's monthly checks — the person asked and saw the answer directly.
 * 30/hour and 200/UTC-day per device (429 with Retry-After). Logs the registrable domain only.
 */
import { logger } from "@neo/core";
import { analyzeUrl, normalizeUrl } from "@neo/tools";
import type { CheckUrlResponse } from "@/lib/signal-types";
import type { NeoSession } from "@/lib/session";
import { sharedUrlCache } from "../agent-run";
import type { Outcome } from "../household";
import { takeDailySlot, takeRateSlot } from "../rate-limit";
import { classifyUrlAnalysis } from "./classify";

const HOUR_MS = 60 * 60 * 1000;
export const CHECK_URL_HOURLY_LIMIT = { limit: 30, windowMs: HOUR_MS } as const;
export const CHECK_URL_DAILY_LIMIT = 200;
const MAX_URL_LENGTH = 2048;

function fail(status: number, code: string, message: string): Outcome<never> {
  return { ok: false, status, code, message };
}

function rateLimited(retryAfterSeconds: number): Outcome<never> {
  return { ok: false, status: 429, code: "rate_limited", message: "Too many requests. Please try again later.", retryAfterSeconds };
}

function urlOf(body: Record<string, unknown> | null): string | null {
  const url = body?.url;
  return typeof url === "string" && url.trim() && url.length <= MAX_URL_LENGTH ? url : null;
}

export async function checkUrl(
  session: NeoSession,
  deviceId: string,
  body: Record<string, unknown> | null,
  now = new Date(),
): Promise<Outcome<CheckUrlResponse>> {
  const hourly = takeRateSlot("device-check-url", deviceId, CHECK_URL_HOURLY_LIMIT.limit, CHECK_URL_HOURLY_LIMIT.windowMs, now.getTime());
  if (!hourly.ok) return rateLimited(hourly.retryAfterSeconds);
  const daily = takeDailySlot("device-check-url-day", deviceId, CHECK_URL_DAILY_LIMIT, now);
  if (!daily.ok) return rateLimited(daily.retryAfterSeconds);

  const raw = urlOf(body);
  if (!raw) return fail(400, "invalid", `Expected { "url": string of at most ${MAX_URL_LENGTH} characters }.`);

  let scheme: string;
  try {
    scheme = normalizeUrl(raw).scheme;
  } catch {
    return fail(400, "invalid", "That does not look like a checkable web address.");
  }
  if (scheme !== "http" && scheme !== "https") return fail(400, "invalid", "Neo can only check http and https links.");

  const analysis = await analyzeUrl(raw, { deps: { cache: sharedUrlCache() } });
  const { rating, reasons } = classifyUrlAnalysis(analysis);
  logger.info("On-demand URL check", "devices", { tenantId: session.tenantId, domain: analysis.domain.registrable });
  return { ok: true, value: { rating, domain: analysis.domain.registrable, reasons, checkedAt: now.toISOString() } };
}
