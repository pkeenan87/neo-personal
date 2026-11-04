/**
 * Timed purges for the rest of the household data (migration 0031_retention_purges; _specs/v2-followups.md slice C) on
 * PGlite as the non-owner app role: the fixed-period purge function returns per-kind counts and deletes only the rows
 * past each rule.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { purgeOldHouseholdRecords } from "../src/retention.js";
import { enrollSelfDevice } from "../src/devices.js";
import { createTenantForUser } from "../src/tenants.js";
import { becomeAppUser, createTestDb, createUser, type TestDb } from "./helpers.js";

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const future = (days: number) => new Date(Date.now() + days * DAY).toISOString();

let t: TestDb;
let tenantId: string;
let deviceId: string;
let owner: string;

// Seeded row ids to verify survivors
let outboxOldSentId: string;
let outboxOldFailedId: string;
let outboxOldUnsentId: string;
let outboxVeryOldUnsentId: string;
let outboxRecentSentId: string;

let inviteAcceptedId: string;
let inviteUnacceptedExpiredId: string;
let inviteUnacceptedFutureId: string;

let cmdCompletedId: string;
let cmdExpiredId: string;
let cmdRecentExpiredId: string;

let eveOldSessionId: string;
let eveRecentSessionId: string;

let usageOldId: string;
let usageRecentId: string;

beforeAll(async () => {
  t = await createTestDb({ createAppUserBeforeMigrations: true });
  owner = await createUser(t.db, "A");
  const tenant = await createTenantForUser(t.db, { userId: owner, name: "A" });
  tenantId = tenant.tenantId;

  const r = await enrollSelfDevice(t.db, {
    tenantId,
    userId: owner,
    role: "owner",
    device: { kind: "desktop_agent", platform: "windows", name: "PC", clientVersion: "1" },
  });
  if ("error" in r) throw new Error(r.error);
  deviceId = r.device.id;

  // Seed rows as the owner (migration owner) before switching to app_user

  // notification_outbox
  {
    const res = await t.client.query<{ id: string }>(
      `INSERT INTO notification_outbox (tenant_id, idempotency_key, channel, destination_ciphertext, template, payload, attempts, sent_at, created_at)
       VALUES ($1, $2, 'email', 'ct', 'tpl', '{}', 1, $3, $4) RETURNING id`,
      [tenantId, randomUUID(), ago(31), ago(31)]
    );
    outboxOldSentId = res.rows[0]!.id;
  }
  {
    const res = await t.client.query<{ id: string }>(
      `INSERT INTO notification_outbox (tenant_id, idempotency_key, channel, destination_ciphertext, template, payload, attempts, sent_at, created_at)
       VALUES ($1, $2, 'email', 'ct', 'tpl', '{}', 5, NULL, $3) RETURNING id`,
      [tenantId, randomUUID(), ago(31)]
    );
    outboxOldFailedId = res.rows[0]!.id;
  }
  {
    const res = await t.client.query<{ id: string }>(
      `INSERT INTO notification_outbox (tenant_id, idempotency_key, channel, destination_ciphertext, template, payload, attempts, sent_at, created_at)
       VALUES ($1, $2, 'email', 'ct', 'tpl', '{}', 1, NULL, $3) RETURNING id`,
      [tenantId, randomUUID(), ago(31)]
    );
    outboxOldUnsentId = res.rows[0]!.id;
  }
  {
    const res = await t.client.query<{ id: string }>(
      `INSERT INTO notification_outbox (tenant_id, idempotency_key, channel, destination_ciphertext, template, payload, attempts, sent_at, created_at)
       VALUES ($1, $2, 'email', 'ct', 'tpl', '{}', 1, NULL, $3) RETURNING id`,
      [tenantId, randomUUID(), ago(91)]
    );
    outboxVeryOldUnsentId = res.rows[0]!.id;
  }
  {
    const res = await t.client.query<{ id: string }>(
      `INSERT INTO notification_outbox (tenant_id, idempotency_key, channel, destination_ciphertext, template, payload, attempts, sent_at, created_at)
       VALUES ($1, $2, 'email', 'ct', 'tpl', '{}', 1, $3, $4) RETURNING id`,
      [tenantId, randomUUID(), ago(5), ago(5)]
    );
    outboxRecentSentId = res.rows[0]!.id;
  }

  // household_invites
  {
    const res = await t.client.query<{ id: string }>(
      `INSERT INTO household_invites (tenant_id, kind, email, token_hash, token_prefix, expires_at, accepted_at, created_at)
       VALUES ($1, 'link', NULL, $2, 'pre', $3, $4, $5) RETURNING id`,
      [tenantId, randomUUID(), ago(40), ago(31), ago(40)]
    );
    inviteAcceptedId = res.rows[0]!.id;
  }
  {
    const res = await t.client.query<{ id: string }>(
      `INSERT INTO household_invites (tenant_id, kind, email, token_hash, token_prefix, expires_at, created_at)
       VALUES ($1, 'link', NULL, $2, 'pre', $3, $4) RETURNING id`,
      [tenantId, randomUUID(), ago(31), ago(40)]
    );
    inviteUnacceptedExpiredId = res.rows[0]!.id;
  }
  {
    const res = await t.client.query<{ id: string }>(
      `INSERT INTO household_invites (tenant_id, kind, email, token_hash, token_prefix, expires_at, created_at)
       VALUES ($1, 'link', NULL, $2, 'pre', $3, $4) RETURNING id`,
      [tenantId, randomUUID(), future(5), ago(1)]
    );
    inviteUnacceptedFutureId = res.rows[0]!.id;
  }

  // device_commands
  {
    const res = await t.client.query<{ id: string }>(
      `INSERT INTO device_commands (tenant_id, device_id, kind, payload, requires_confirmation, status, expires_at, completed_at, created_at)
       VALUES ($1, $2, 'end_session', '{}', false, 'done', $3, $4, $5) RETURNING id`,
      [tenantId, deviceId, ago(31), ago(31), ago(31)]
    );
    cmdCompletedId = res.rows[0]!.id;
  }
  {
    const res = await t.client.query<{ id: string }>(
      `INSERT INTO device_commands (tenant_id, device_id, kind, payload, requires_confirmation, status, expires_at, completed_at, created_at)
       VALUES ($1, $2, 'end_session', '{}', false, 'expired', $3, NULL, $4) RETURNING id`,
      [tenantId, deviceId, ago(31), ago(31)]
    );
    cmdExpiredId = res.rows[0]!.id;
  }
  {
    const res = await t.client.query<{ id: string }>(
      `INSERT INTO device_commands (tenant_id, device_id, kind, payload, requires_confirmation, status, expires_at, completed_at, created_at)
       VALUES ($1, $2, 'end_session', '{}', false, 'expired', $3, NULL, $4) RETURNING id`,
      [tenantId, deviceId, ago(5), ago(5)]
    );
    cmdRecentExpiredId = res.rows[0]!.id;
  }

  // eve_sessions
  {
    const res = await t.client.query<{ session_id: string }>(
      `INSERT INTO eve_sessions (session_id, tenant_id, user_id, created_at)
       VALUES ($1, $2, $3, $4) RETURNING session_id`,
      ["wrun_old1", tenantId, owner, ago(91)]
    );
    eveOldSessionId = res.rows[0]!.session_id;
  }
  {
    const res = await t.client.query<{ session_id: string }>(
      `INSERT INTO eve_sessions (session_id, tenant_id, user_id, created_at)
       VALUES ($1, $2, $3, $4) RETURNING session_id`,
      ["wrun_recent1", tenantId, owner, ago(10)]
    );
    eveRecentSessionId = res.rows[0]!.session_id;
  }

  // usage_events
  {
    const res = await t.client.query<{ id: string }>(
      `INSERT INTO usage_events (tenant_id, user_id, model, created_at)
       VALUES ($1, $2, 'm', $3) RETURNING id`,
      [tenantId, owner, ago(401)]
    );
    usageOldId = res.rows[0]!.id;
  }
  {
    const res = await t.client.query<{ id: string }>(
      `INSERT INTO usage_events (tenant_id, user_id, model, created_at)
       VALUES ($1, $2, 'm', $3) RETURNING id`,
      [tenantId, owner, ago(30)]
    );
    usageRecentId = res.rows[0]!.id;
  }

  await becomeAppUser(t.client);
}, 60_000);

afterAll(async () => {
  await t?.close();
});

describe("purgeOldHouseholdRecords", () => {
  it("deletes only rows past each rule and returns per-kind counts", async () => {
    const result = await purgeOldHouseholdRecords(t.db);
    expect(result).toEqual({
      outbox: 3,
      invites: 2,
      deviceCommands: 2,
      eveSessions: 1,
      usageEvents: 1,
    });

    // Check survivors as the owner (reset role to bypass tenant scoping)
    await t.client.exec("reset role");

    const outboxRes = await t.client.query<{ id: string }>("SELECT id FROM notification_outbox ORDER BY id");
    const outboxIds = outboxRes.rows.map((r: { id: string }) => r.id).sort();
    expect(outboxIds).toEqual([outboxOldUnsentId, outboxRecentSentId].sort());

    const invitesRes = await t.client.query<{ id: string }>("SELECT id FROM household_invites ORDER BY id");
    const inviteIds = invitesRes.rows.map((r: { id: string }) => r.id).sort();
    expect(inviteIds).toEqual([inviteUnacceptedFutureId]);

    const cmdRes = await t.client.query<{ id: string }>("SELECT id FROM device_commands ORDER BY id");
    const cmdIds = cmdRes.rows.map((r: { id: string }) => r.id).sort();
    expect(cmdIds).toEqual([cmdRecentExpiredId]);

    const eveRes = await t.client.query<{ session_id: string }>("SELECT session_id FROM eve_sessions ORDER BY session_id");
    const eveIds = eveRes.rows.map((r: { session_id: string }) => r.session_id).sort();
    expect(eveIds).toEqual([eveRecentSessionId]);

    const usageRes = await t.client.query<{ id: string }>("SELECT id FROM usage_events ORDER BY id");
    const usageIds = usageRes.rows.map((r: { id: string }) => r.id).sort();
    expect(usageIds).toEqual([usageRecentId]);

    const remaining = [...outboxIds, ...inviteIds, ...cmdIds, ...eveIds, ...usageIds];
    const deleted = [outboxOldSentId, outboxOldFailedId, outboxVeryOldUnsentId, inviteAcceptedId, inviteUnacceptedExpiredId, cmdCompletedId, cmdExpiredId, eveOldSessionId, usageOldId];
    for (const id of deleted) expect(remaining).not.toContain(id);
  });
});
