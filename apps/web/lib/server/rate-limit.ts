/**
 * Fixed-window, per-instance rate limiter for unauthenticated or cheap
 * endpoints. Same limits as the artifact upload limiter: per process, so a
 * multi-instance deployment allows `limit` per instance. Good enough to blunt
 * abuse of endpoints whose secrets are unguessable anyway.
 */
const g = globalThis as typeof globalThis & {
  __neoRateBuckets?: Map<string, number[]>;
  __neoDailySlots?: Map<string, { day: string; count: number }>;
};

function buckets(): Map<string, number[]> {
  g.__neoRateBuckets ??= new Map();
  return g.__neoRateBuckets;
}

function dailySlots(): Map<string, { day: string; count: number }> {
  g.__neoDailySlots ??= new Map();
  return g.__neoDailySlots;
}

export function takeRateSlot(
  bucket: string,
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): { ok: true } | { ok: false; retryAfterSeconds: number } {
  const all = buckets();
  const k = `${bucket}:${key}`;
  const recent = (all.get(k) ?? []).filter((t) => t > now - windowMs);
  if (recent.length >= limit) {
    all.set(k, recent);
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(((recent[0] ?? now) + windowMs - now) / 1000)) };
  }
  recent.push(now);
  all.set(k, recent);
  // Keep the map bounded: drop other keys' stale windows occasionally.
  if (all.size > 10_000) for (const [key2, ts] of all) if (!ts.some((t) => t > now - windowMs)) all.delete(key2);
  return { ok: true };
}

/**
 * A cap per UTC calendar day (not a rolling 24h window): resets at midnight UTC, not 24h
 * after the first request. Used where there is no stored-row count to query (unlike
 * lib/server/signals/ingest.ts's per-device daily event cap).
 */
export function takeDailySlot(
  bucket: string,
  key: string,
  limit: number,
  now = new Date(),
): { ok: true } | { ok: false; retryAfterSeconds: number } {
  const day = now.toISOString().slice(0, 10);
  const all = dailySlots();
  const k = `${bucket}:${key}`;
  const entry = all.get(k);
  if (!entry || entry.day !== day) {
    all.set(k, { day, count: 1 });
    return { ok: true };
  }
  if (entry.count >= limit) {
    const nextMidnightUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((nextMidnightUtc - now.getTime()) / 1000)) };
  }
  entry.count += 1;
  return { ok: true };
}

/** 429 with Retry-After, the same body shape as the artifact upload limiter. */
export function rateLimitedResponse(retryAfterSeconds: number): Response {
  return Response.json(
    { error: "Too many attempts. Please try again later.", code: "rate_limited" },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds), "Cache-Control": "no-store" } },
  );
}

export function resetRateLimits(): void {
  g.__neoRateBuckets = new Map();
  g.__neoDailySlots = new Map();
}

/** Client IP for rate limiting: first hop of x-forwarded-for, else x-real-ip, else "unknown". */
export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || req.headers.get("x-real-ip")?.trim() || "unknown";
}
