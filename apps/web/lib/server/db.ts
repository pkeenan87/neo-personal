/**
 * The app's single Postgres client. `createDb()` opens a connection pool, so it
 * is created once per process (kept on globalThis so dev hot reloads reuse it).
 *
 * Returns null when DATABASE_URL is unset: MOCK_MODE and the test suite then
 * run on the in-memory fallbacks (conversation store, usage, audit), so the app
 * works with zero infrastructure. Production always sets DATABASE_URL.
 */
import { createDb, type Db } from "@neo/db";
import { env } from "@/lib/env";

const g = globalThis as typeof globalThis & { __neoDb?: { url: string; db: Db } };

export function getDb(): Db | null {
  const url = env().DATABASE_URL;
  if (!url) return null;
  if (g.__neoDb?.url !== url) g.__neoDb = { url, db: createDb(url) };
  return g.__neoDb.db;
}
