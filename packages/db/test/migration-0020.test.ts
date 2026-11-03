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
const dirs: string[] = [];
const clients: PGlite[] = [];

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A database migrated to 0019 (the last migration before member-only devices) and the means to run the rest. */
async function databaseAt0019(): Promise<{ client: PGlite; finish: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), "neo-mig-0020-"));
  dirs.push(dir);
  cpSync(migrationsFolder, dir, { recursive: true });
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: Array<{ tag: string }> };
  expect(journal.entries.some((e) => e.tag === "0020_member_devices")).toBe(true);
  journal.entries = journal.entries.filter((e) => e.tag < "0020");
  writeFileSync(journalPath, JSON.stringify(journal));
  const client = new PGlite();
  clients.push(client);
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: dir });
  return { client, finish: () => migrate(db, { migrationsFolder }) };
}

const T = "11111111-1111-4111-8111-111111111111";
const M1 = "aaaaaaaa-0000-4000-8000-000000000001";
const M2 = "aaaaaaaa-0000-4000-8000-000000000002";
const D1 = "dddddddd-0000-4000-8000-000000000001";
const D2 = "dddddddd-0000-4000-8000-000000000002";
const D3 = "dddddddd-0000-4000-8000-000000000003";

const SEED = `
  insert into users (id, name, email) values ('u1','Owner','u1@example.test'), ('u2','Gran','u2@example.test'), ('u3','Gone','u3@example.test');
  insert into tenants (id, name) values ('${T}', 'Household');
  insert into memberships (tenant_id, user_id, role) values ('${T}','u1','owner'), ('${T}','u2','member');
  insert into members (id, tenant_id, user_id, display_name, role) values ('${M1}','${T}','u1','Owner','owner'), ('${M2}','${T}','u2','Gran','adult');
  -- d1: the normal case. d2: a straggler 0017 never reached (active, no member). d3: a removed person's revoked device.
  insert into devices (id, tenant_id, user_id, member_id, kind, platform, name, client_version, enrollment)
    values ('${D1}','${T}','u1','${M1}','desktop_agent','windows','Owner PC','1','self');
  insert into devices (id, tenant_id, user_id, kind, platform, name, client_version, enrollment)
    values ('${D2}','${T}','u2','browser_extension','chrome','Gran Chrome','1','code');
  insert into devices (id, tenant_id, user_id, kind, platform, name, client_version, enrollment, revoked_at)
    values ('${D3}','${T}','u3','browser_extension','chrome','Gone Chrome','1','code', now());
  insert into device_enrollment_codes (tenant_id, user_id, code_hash, expires_at) values ('${T}','u2','pending-hash', now() + interval '1 day');
  insert into device_enrollment_codes (tenant_id, user_id, code_hash, expires_at, redeemed_at) values ('${T}','u3','redeemed-hash', now() + interval '1 day', now());
  insert into device_signals (tenant_id, device_id, user_id, client_event_id, type, detector, subject, payload, observed_at) values
    ('${T}','${D1}','u1',gen_random_uuid(),'web','scam_page','a.example','{}', now()),
    ('${T}','${D2}','u2',gen_random_uuid(),'web','scam_page','b.example','{}', now()),
    ('${T}','${D3}','u3',gen_random_uuid(),'web','scam_page','c.example','{}', now());
  insert into desktop_tokens (id, user_id, tenant_id, role, name, token_hash, token_prefix) values
    ('bbbbbbbb-0000-4000-8000-000000000001','u1','${T}','owner','Full','h-full','pfx00001');
  insert into desktop_tokens (id, user_id, tenant_id, role, name, token_hash, token_prefix, scopes, device_id) values
    ('bbbbbbbb-0000-4000-8000-000000000002','u1','${T}','owner','Owner PC','h-d1','pfx00002','{device,signals:write,url:check}','${D1}'),
    ('bbbbbbbb-0000-4000-8000-000000000003','u2','${T}','member','Gran Chrome','h-d2','pfx00003','{device,signals:write,url:check}','${D2}'),
    ('bbbbbbbb-0000-4000-8000-000000000004','u3','${T}','member','Gone Chrome','h-d3','pfx00004','{device,signals:write,url:check}','${D3}');
`;

describe("migration 0020_member_devices on an existing database", () => {
  it("backfills member_id, keeps what it must, and enforces the new constraints", async () => {
    const { client, finish } = await databaseAt0019();
    await client.exec(SEED);
    await finish();

    const q = async <R extends object>(sql: string) => (await client.query<R>(sql)).rows;
    expect(await q("select id, member_id from devices order by id")).toEqual([
      { id: D1, member_id: M1 },
      { id: D2, member_id: M2 }, // the straggler is backfilled through its user
      { id: D3, member_id: null }, // revoked, its person was removed: allowed to stay without a member
    ]);
    expect(await q("select code_hash, member_id from device_enrollment_codes order by code_hash")).toEqual([
      { code_hash: "pending-hash", member_id: M2 },
      { code_hash: "redeemed-hash", member_id: null },
    ]);
    // Signals follow their device's member; one whose member no longer exists is gone (as the cascade would have done).
    expect(await q("select subject, member_id, user_id from device_signals order by subject")).toEqual([
      { subject: "a.example", member_id: M1, user_id: "u1" },
      { subject: "b.example", member_id: M2, user_id: "u2" },
    ]);
    const tokens = await q<{ token_hash: string; member_id: string | null; revoked: boolean }>(
      "select token_hash, member_id, revoked_at is not null as revoked from desktop_tokens order by token_hash",
    );
    expect(tokens).toEqual([
      { token_hash: "h-d1", member_id: M1, revoked: false },
      { token_hash: "h-d2", member_id: M2, revoked: false },
      { token_hash: "h-d3", member_id: null, revoked: true }, // no member: not left usable
      { token_hash: "h-full", member_id: null, revoked: false },
    ]);

    // Nullability: the user columns open up, device_signals.member_id closes.
    const nullable = await q<{ table_name: string; column_name: string; is_nullable: string }>(
      `select table_name, column_name, is_nullable from information_schema.columns where table_schema = 'public' and
       (table_name, column_name) in (('devices','user_id'),('device_enrollment_codes','user_id'),('device_signals','user_id'),('desktop_tokens','user_id'),('desktop_tokens','role'),('device_signals','member_id'),('desktop_tokens','member_id'),('tenants','time_zone'))
       order by table_name, column_name`,
    );
    expect(nullable.map((r) => `${r.table_name}.${r.column_name}:${r.is_nullable}`)).toEqual([
      "desktop_tokens.member_id:YES",
      "desktop_tokens.role:YES",
      "desktop_tokens.user_id:YES",
      "device_enrollment_codes.user_id:YES",
      "device_signals.member_id:NO",
      "device_signals.user_id:YES",
      "devices.user_id:YES",
      "tenants.time_zone:YES",
    ]);
    expect(await q("select time_zone from tenants")).toEqual([{ time_zone: null }]);

    // Constraints.
    const device = (cols: string, vals: string) =>
      `insert into devices (tenant_id, ${cols}, kind, platform, name, client_version, enrollment) values ('${T}', ${vals}, 'desktop_agent', 'linux', 'x', '1', 'self')`;
    await expect(client.exec(device("user_id", "null"))).rejects.toThrow(/devices_member_check/);
    await expect(client.exec(device("user_id", "'u3'"))).rejects.toThrow(/devices_member_check/); // no members row for u3
    await client.exec(device("user_id, member_id", `null, '${M2}'`)); // a member without an account
    await expect(client.exec(`update devices set member_id = null where id = '${D1}'`)).rejects.toThrow(/devices_member_check/);
    await client.exec(`update devices set member_id = null, revoked_at = now() where id = '${D1}'`); // revoked: fine

    await expect(
      client.exec(`insert into desktop_tokens (tenant_id, name, token_hash, token_prefix) values ('${T}','x','h-nouser','pfx')`),
    ).rejects.toThrow(/desktop_tokens_subject_check|null value/);
    await expect(
      client.exec(`insert into desktop_tokens (user_id, tenant_id, role, name, token_hash, token_prefix) values (null,'${T}','owner','x','h-nouser','pfx')`),
    ).rejects.toThrow(/desktop_tokens_subject_check/); // a full token needs a user
    await expect(
      client.exec(`insert into desktop_tokens (user_id, tenant_id, role, name, token_hash, token_prefix) values ('u1','${T}',null,'x','h-norole','pfx')`),
    ).rejects.toThrow(/desktop_tokens_subject_check/); // and a role
    await expect(
      client.exec(`insert into desktop_tokens (tenant_id, name, token_hash, token_prefix, scopes, device_id) values ('${T}','x','h-nomember','pfx','{device}', '${D3}')`),
    ).rejects.toThrow(/desktop_tokens_device_scope_check|desktop_tokens_subject_check/);
    // A monitoring token needs a device and a member; it may lose the member once revoked.
    const [m2dev] = await q<{ id: string }>(`select id from devices where user_id is null and member_id = '${M2}'`);
    await client.exec(
      `insert into desktop_tokens (tenant_id, name, token_hash, token_prefix, scopes, device_id) values ('${T}','accountless','h-ok','pfx','{device}', '${m2dev!.id}')`,
    ); // the trigger fills member_id from the device
    expect(await q("select user_id, role, member_id from desktop_tokens where token_hash = 'h-ok'")).toEqual([{ user_id: null, role: null, member_id: M2 }]);
    await expect(client.exec(`update desktop_tokens set member_id = null where token_hash = 'h-ok'`)).rejects.toThrow(/desktop_tokens_subject_check/);
    await client.exec(`update desktop_tokens set member_id = null, revoked_at = now() where token_hash = 'h-ok'`);
    await expect(
      client.exec(`insert into desktop_tokens (user_id, tenant_id, role, name, token_hash, token_prefix) values ('u1','${T}','admin','x','h-badrole','pfx')`),
    ).rejects.toThrow(/desktop_tokens_role_check/);

    // A pending code needs a member; a revoked or redeemed one may lose it.
    await expect(
      client.exec(`insert into device_enrollment_codes (tenant_id, user_id, code_hash, expires_at) values ('${T}', null, 'c-none', now() + interval '1 day')`),
    ).rejects.toThrow(/device_enrollment_codes_member_check/);
    await client.exec(`insert into device_enrollment_codes (tenant_id, member_id, code_hash, expires_at) values ('${T}', '${M2}', 'c-member', now() + interval '1 day')`);

    // The new signals index exists, and a signal needs a member (filled from its device when a legacy writer omits it).
    expect(await q("select indexname from pg_indexes where indexname = 'device_signals_tenant_member_observed_idx'")).toHaveLength(1);
    await client.exec(
      `insert into device_signals (tenant_id, device_id, user_id, client_event_id, type, detector, subject, payload, observed_at)
       values ('${T}','${D2}','u2',gen_random_uuid(),'web','scam_page','legacy.example','{}', now())`,
    );
    expect(await q("select member_id from device_signals where subject = 'legacy.example'")).toEqual([{ member_id: M2 }]);
    await client.exec(
      `insert into device_signals (tenant_id, device_id, user_id, member_id, client_event_id, type, detector, subject, payload, observed_at)
       values ('${T}','${D2}','u2',null,gen_random_uuid(),'web','scam_page','x','{}', now())`,
    ); // the trigger fills an explicit null too
    // Deleting a member cascades to its signals (retention-purged telemetry), and revoked devices keep their rows.
    await client.exec(`update devices set revoked_at = now() where member_id = '${M2}'`);
    await client.exec(`update desktop_tokens set revoked_at = now() where member_id = '${M2}'`);
    await client.exec(`update device_enrollment_codes set revoked_at = now() where member_id = '${M2}'`);
    await client.exec(`delete from members where id = '${M2}'`);
    expect(await q("select count(*)::int as n from device_signals where member_id = '" + M2 + "'")).toEqual([{ n: 0 }]);
    expect((await q<{ n: number }>(`select count(*)::int as n from devices where user_id = 'u2' or name = 'Gran Chrome'`))[0]!.n).toBeGreaterThan(0);
  });

  it("fails loudly when an active device still has no member", async () => {
    const { client, finish } = await databaseAt0019();
    await client.exec(`
      insert into users (id, name, email) values ('u9','Nobody','u9@example.test');
      insert into tenants (id, name) values ('${T}', 'Household');
      insert into devices (tenant_id, user_id, kind, platform, name, client_version, enrollment)
        values ('${T}','u9','browser_extension','chrome','Orphan','1','code');
    `);
    await expect(finish()).rejects.toThrow(/active device\(s\) have no members row/);
  });

  it("fails loudly when a pending enrollment code still has no member", async () => {
    const { client, finish } = await databaseAt0019();
    await client.exec(`
      insert into users (id, name, email) values ('u9','Nobody','u9@example.test');
      insert into tenants (id, name) values ('${T}', 'Household');
      insert into device_enrollment_codes (tenant_id, user_id, code_hash, expires_at) values ('${T}','u9','orphan', now() + interval '1 day');
    `);
    await expect(finish()).rejects.toThrow(/pending enrollment code\(s\) have no members row/);
  });
});
