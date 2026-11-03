/** The process-wide URL reputation cache; no Next imports, so the eve agent shares it with the chat tools. */
import { PostgresReputationCache } from "@neo/db";
import { createInMemoryCache, type ReputationCache } from "@neo/tools";
import { getDb } from "./db";

const g = globalThis as typeof globalThis & { __neoUrlCache?: ReputationCache; __neoUrlCacheDbBacked?: boolean };

/**
 * The process-wide URL reputation cache shared by chat tools, the inbound job and signal
 * escalations (_specs/signals.md "Shared reputation cache"). `PostgresReputationCache`
 * (`reputation_cache`, 24h TTL, no tenant) when a database is configured, so households share
 * lookups; the in-memory twin otherwise (MOCK_MODE / tests). Switches twin↔database if the
 * database becomes available after the first call (tests toggling DATABASE_URL).
 */
export function sharedUrlCache(): ReputationCache {
  const db = getDb();
  const dbBacked = Boolean(db);
  if (!g.__neoUrlCache || g.__neoUrlCacheDbBacked !== dbBacked) {
    g.__neoUrlCache = db ? new PostgresReputationCache(db) : createInMemoryCache();
    g.__neoUrlCacheDbBacked = dbBacked;
  }
  return g.__neoUrlCache;
}
