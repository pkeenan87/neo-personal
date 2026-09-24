import type { ReputationCache } from "./types.js";

export const CACHE_KEY_PREFIX = "neo:url-analysis:v1:";

export function urlAnalysisCacheKey(normalizedUrl: string): string {
  return `${CACHE_KEY_PREFIX}${normalizedUrl}`;
}

/**
 * Process-local TTL cache (insertion-order eviction). Fine for a single
 * server/dev; on Vercel use a shared store (e.g. Redis/Postgres) implementing
 * the same `ReputationCache` interface.
 */
export class InMemoryReputationCache implements ReputationCache {
  private readonly entries = new Map<string, { value: unknown; expiresAt: number }>();

  constructor(
    private readonly maxEntries = 1000,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): unknown {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return structuredClone(e.value);
  }

  set(key: string, value: unknown, ttlSeconds: number): void {
    this.entries.delete(key);
    this.entries.set(key, { value: structuredClone(value), expiresAt: this.now() + ttlSeconds * 1000 });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

export function createInMemoryCache(maxEntries?: number): InMemoryReputationCache {
  return new InMemoryReputationCache(maxEntries);
}
