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

/**
 * Switch the PGlite session to a non-owner, NOBYPASSRLS role, mirroring
 * sql/create-app-user.sql (minus LOGIN/password, not needed for SET ROLE). Undo with
 * `client.exec("reset role")`. Call at most once per database.
 */
export async function becomeAppUser(client: PGlite): Promise<void> {
  await client.exec(`
    create role app_user nologin nobypassrls;
    grant usage on schema public to app_user;
    grant select, insert, update, delete on all tables in schema public to app_user;
    grant execute on function public.resolve_inbound_address(text) to app_user;
    grant execute on function public.list_expired_artifacts(integer) to app_user;
    grant execute on function public.purge_old_inbound_messages(integer) to app_user;
    set role app_user;
  `);
}
