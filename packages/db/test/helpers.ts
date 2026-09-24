import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Db } from "../src/client.js";
import * as schema from "../src/schema/index.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

export type TestDb = { db: Db; client: PGlite; close: () => Promise<void> };

/** Fresh in-memory Postgres (PGlite) with the committed migrations applied. */
export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite();
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder });
  return { db, client, close: () => client.close() };
}

let userSeq = 0;

export async function createUser(db: Db, name = "Test User"): Promise<string> {
  userSeq += 1;
  const [row] = await db
    .insert(schema.users)
    .values({ name, email: `user${userSeq}-${Date.now()}@example.test` })
    .returning({ id: schema.users.id });
  if (!row) throw new Error("user insert failed");
  return row.id;
}
