/**
 * Apply the committed SQL migrations in packages/db/drizzle.
 *
 *   MIGRATION_DATABASE_URL=... pnpm --filter @neo/db migrate
 *
 * Uses MIGRATION_DATABASE_URL (the owner role) when set, else DATABASE_URL. The app role
 * (app_user) must NOT own the tables, or RLS will not apply to it; see docs/rls.md.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { Pool as NeonPool } from "@neondatabase/serverless";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import { migrate as migrateNeon } from "drizzle-orm/neon-serverless/migrator";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { selectDriver } from "./client.js";

/** Absolute path of the committed migrations folder (works from src/ and dist/). */
export const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

export async function runMigrations(connectionString: string): Promise<void> {
  if (selectDriver(connectionString) === "neon") {
    const pool = new NeonPool({ connectionString });
    try {
      await migrateNeon(drizzleNeon({ client: pool }), { migrationsFolder });
    } finally {
      await pool.end();
    }
    return;
  }
  const pool = new pg.Pool({ connectionString });
  try {
    await migratePg(drizzlePg({ client: pool }), { migrationsFolder });
  } finally {
    await pool.end();
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error("@neo/db migrate: set MIGRATION_DATABASE_URL or DATABASE_URL");
    process.exit(1);
  }
  runMigrations(url).then(
    () => {
      console.log("@neo/db migrate: migrations applied");
    },
    (err: unknown) => {
      console.error("@neo/db migrate: failed", err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
