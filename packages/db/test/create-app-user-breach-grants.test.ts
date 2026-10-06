import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers.js";

describe("post-migration app_user role grants", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
    await t.client.exec("CREATE ROLE app_user NOLOGIN NOBYPASSRLS; GRANT USAGE ON SCHEMA public TO app_user;");
  });
  afterAll(async () => t.close());

  it("grants only the breach scheduler helpers listed in create-app-user.sql", async () => {
    const script = readFileSync(new URL("../sql/create-app-user.sql", import.meta.url), "utf8");
    const grants = script.split(/\r?\n/).filter((line) => /^\s*GRANT EXECUTE ON FUNCTION public\.(list_monitored_breach_addresses|purge_expired_breach_verification_tokens)\(/i.test(line));
    expect(grants).toHaveLength(2);
    for (const grant of grants) await t.client.exec(`${grant};`);
    const result = await t.client.query<{ list_ok: boolean; purge_ok: boolean }>(`SELECT
      has_function_privilege('app_user', 'public.list_monitored_breach_addresses(uuid,text,uuid,integer)', 'EXECUTE') AS list_ok,
      has_function_privilege('app_user', 'public.purge_expired_breach_verification_tokens()', 'EXECUTE') AS purge_ok`);
    expect(result.rows[0]).toEqual({ list_ok: true, purge_ok: true });
  });
});
