import { Pool as NeonPool } from "@neondatabase/serverless";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import pg from "pg";
import * as schema from "./schema/index.js";

export type Schema = typeof schema;

/**
 * Any Drizzle Postgres database carrying the Neo schema: Neon serverless (WebSocket pool,
 * supports interactive transactions), node-postgres, or PGlite in tests.
 */
export type Db = PgDatabase<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;
export type Tx = PgTransaction<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;

export type DbDriver = "neon" | "pg";

/**
 * Driver choice: `NEO_DB_DRIVER` ("neon" | "pg") wins; otherwise Neon when the host ends
 * with `neon.tech`, node-postgres for everything else.
 */
export function selectDriver(connectionString: string, env: NodeJS.ProcessEnv = process.env): DbDriver {
  const forced = env.NEO_DB_DRIVER?.trim().toLowerCase();
  if (forced === "neon" || forced === "pg") return forced;
  try {
    const host = new URL(connectionString).hostname.toLowerCase();
    return host === "neon.tech" || host.endsWith(".neon.tech") ? "neon" : "pg";
  } catch {
    return "pg";
  }
}

/**
 * Create a Drizzle client. Defaults to `DATABASE_URL`. Creates a connection pool, so call
 * once per process (module scope) and reuse, rather than once per request.
 */
export function createDb(connectionString: string | undefined = process.env.DATABASE_URL): Db {
  if (!connectionString) {
    throw new Error("@neo/db: DATABASE_URL is not set and no connection string was passed to createDb()");
  }
  if (selectDriver(connectionString) === "neon") {
    // Pool (WebSocket) rather than neon-http: tenantScoped() needs interactive transactions.
    // Node >= 22 provides a global WebSocket, so no `ws` polyfill is needed.
    const pool = new NeonPool({ connectionString });
    return drizzleNeon({ client: pool, schema });
  }
  const pool = new pg.Pool({ connectionString });
  return drizzlePg({ client: pool, schema });
}
