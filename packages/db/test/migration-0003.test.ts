import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, describe, expect, it } from "vitest";
import * as schema from "../src/schema/index.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

describe("migration 0003_phase1 on an existing database", () => {
  const dir = mkdtempSync(join(tmpdir(), "neo-mig-"));
  const client = new PGlite();
  afterAll(async () => {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("backfills artifacts.mime_type and verdicts.source for existing rows", async () => {
    // A copy of the migrations folder that stops before 0003.
    cpSync(migrationsFolder, dir, { recursive: true });
    const journalPath = join(dir, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: Array<{ tag: string }> };
    journal.entries = journal.entries.filter((e) => e.tag < "0003");
    writeFileSync(journalPath, JSON.stringify(journal));

    const db = drizzle({ client, schema });
    await migrate(db, { migrationsFolder: dir });
    await client.exec(`
      insert into users (id, name, email) values ('u1', 'U', 'u1@example.test');
      insert into tenants (id, name) values ('11111111-1111-4111-8111-111111111111', 'T');
      insert into artifacts (tenant_id, user_id, kind, blob_url, sha256, size_bytes, encrypted)
        values ('11111111-1111-4111-8111-111111111111', 'u1', 'eml', 'memory://x', 'abc', 3, true);
      insert into verdicts (tenant_id, user_id, subject_type, verdict, confidence, headline, body)
        values ('11111111-1111-4111-8111-111111111111', 'u1', 'url', 'likely_safe', 0.5, 'h', '{}');
    `);

    await migrate(db, { migrationsFolder });

    const a = await client.query<{ mime_type: string; source: string; filename: string | null }>(
      "select mime_type, source, filename from artifacts",
    );
    expect(a.rows).toEqual([{ mime_type: "application/octet-stream", source: "upload", filename: null }]);
    const v = await client.query<{ source: string; artifact_id: string | null }>("select source, artifact_id from verdicts");
    expect(v.rows).toEqual([{ source: "chat", artifact_id: null }]);

    // The temporary default is gone: new rows must name their type.
    await expect(
      client.exec(`insert into artifacts (tenant_id, user_id, kind, blob_url, sha256, size_bytes, encrypted)
        values ('11111111-1111-4111-8111-111111111111', 'u1', 'eml', 'memory://y', 'abc', 3, true)`),
    ).rejects.toThrow(/mime_type/);
    await expect(
      client.exec(`insert into artifacts (tenant_id, user_id, kind, blob_url, sha256, size_bytes, encrypted, mime_type, source)
        values ('11111111-1111-4111-8111-111111111111', 'u1', 'eml', 'memory://z', 'abc', 3, true, 'message/rfc822', 'bogus')`),
    ).rejects.toThrow(/artifacts_source_check/);

    // The security-definer functions exist, pin search_path, and are not executable by PUBLIC.
    const fns = await client.query<{ proname: string; prosecdef: boolean; config: string | null }>(
      `select proname, prosecdef, array_to_string(proconfig, ',') as config from pg_proc
       where proname in ('resolve_inbound_address', 'list_expired_artifacts', 'purge_old_inbound_messages') order by proname`,
    );
    expect(fns.rows.map((r) => r.proname)).toEqual(["list_expired_artifacts", "purge_old_inbound_messages", "resolve_inbound_address"]);
    for (const r of fns.rows) {
      expect(r.prosecdef, r.proname).toBe(true);
      expect(r.config, r.proname).toContain("search_path=pg_catalog, public");
    }
    const purged = await client.query<{ n: number }>("select purge_old_inbound_messages(90) as n");
    expect(purged.rows[0]?.n).toBe(0);
  });
});
