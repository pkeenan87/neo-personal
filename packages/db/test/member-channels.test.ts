/** Member-linked channels and migration 0026 on PGlite, as the non-owner app role. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMemberForUser, createMemberWithoutAccount } from "../src/members.js";
import {
  CHANNEL_CODE_MAX_ATTEMPTS,
  CHANNEL_CODE_TTL_MS,
  MAX_CHANNELS_PER_MEMBER,
  confirmChannelVerification,
  hashChannelCode,
  listMemberChannels,
  lookupMemberChannel,
  normalizeE164,
  removeMemberChannel,
  startChannelVerification,
} from "../src/member-channels.js";
import { tenantScoped } from "../src/tenant.js";
import { createTenantForUser } from "../src/tenants.js";
import { becomeAppUser, createTestDb, createUser, type TestDb } from "./helpers.js";

const ENV = { NEO_MASTER_KEY: Buffer.alloc(32, 9).toString("base64") } as NodeJS.ProcessEnv;
const NUMBER = "+15551230001";
const now = new Date("2026-11-03T10:00:00Z");

describe("pure helpers", () => {
  it("normalizes E.164", () => {
    expect(normalizeE164(" +1 (555) 123-0001 ")).toBe("+15551230001");
    expect(normalizeE164("+44.20.7946.0958")).toBe("+442079460958");
    for (const bad of ["5551230001", "+0123456789", "+1234", "+1555123000099999", "+1555abc0001", "", "+1\n5551230001x"]) expect(normalizeE164(bad), bad).toBeNull();
  });
  it("hashes the code keyed by household, member and number", () => {
    const h = hashChannelCode("t1", "m1", NUMBER, "123456", ENV);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain("123456");
    expect(hashChannelCode("t1", "m1", NUMBER, "123456", ENV)).toBe(h);
    expect(hashChannelCode("t2", "m1", NUMBER, "123456", ENV)).not.toBe(h);
    expect(hashChannelCode("t1", "m2", NUMBER, "123456", ENV)).not.toBe(h);
    expect(hashChannelCode("t1", "m1", "+15551230002", "123456", ENV)).not.toBe(h);
    expect(() => hashChannelCode("t1", "m1", NUMBER, "123456", { NODE_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(/NEO_MASTER_KEY/);
  });
});

describe("member channels", () => {
  let t: TestDb;
  let tenantA: string;
  let tenantB: string;
  let ownerA: string;
  let memberA: string;
  let kidA: string;
  let memberB: string;

  beforeAll(async () => {
    t = await createTestDb();
    ownerA = await createUser(t.db, "Owner A");
    const ownerB = await createUser(t.db, "Owner B");
    tenantA = (await createTenantForUser(t.db, { userId: ownerA, name: "A" })).tenantId;
    tenantB = (await createTenantForUser(t.db, { userId: ownerB, name: "B" })).tenantId;
    memberA = (await createMemberForUser(tenantScoped(t.db, tenantA), { userId: ownerA, displayName: "Owner A", role: "owner" })).id;
    kidA = (await createMemberWithoutAccount(tenantScoped(t.db, tenantA), { displayName: "Gran", role: "adult" })).id;
    memberB = (await createMemberForUser(tenantScoped(t.db, tenantB), { userId: ownerB, displayName: "Owner B", role: "owner" })).id;
    await becomeAppUser(t.client);
  });
  afterAll(async () => {
    await t.close();
  });

  const A = () => tenantScoped(t.db, tenantA);
  const B = () => tenantScoped(t.db, tenantB);

  /** Raw rows of the tenant (RLS applies: the connection runs as app_user). */
  async function rawRows<R extends object>(tenantId: string, query: string): Promise<R[]> {
    await t.client.query("select set_config('app.tenant_id', $1, false)", [tenantId]);
    try {
      return (await t.client.query<R>(query)).rows;
    } finally {
      await t.client.query("select set_config('app.tenant_id', '', false)");
    }
  }

  async function link(tdb: ReturnType<typeof A>, memberId: string, platformId: string): Promise<string> {
    const started = await startChannelVerification(tdb, { memberId, channel: "sms", platformId }, { now, source: ENV });
    if (!started.ok) throw new Error(`start failed: ${started.reason}`);
    return started.code;
  }

  it("migration 0026: RLS, partial unique index, outbox accepts sms, definer function", async () => {
    const rls = await t.client.query<{ relrowsecurity: boolean }>("select relrowsecurity from pg_class where relname = 'member_channels'");
    expect(rls.rows[0]?.relrowsecurity).toBe(true);
    const idx = await t.client.query<{ indexdef: string }>("select indexdef from pg_indexes where indexname = 'member_channels_verified_idx'");
    expect(idx.rows[0]?.indexdef).toMatch(/UNIQUE.*\(channel, platform_id\).*verified_at IS NOT NULL/s);
    const fn = await t.client.query<{ prosecdef: boolean }>("select prosecdef from pg_proc where proname = 'lookup_member_channel'");
    expect(fn.rows[0]?.prosecdef).toBe(true);
    const chk = await t.client.query<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'notification_outbox_channel_check'");
    expect(chk.rows[0]?.def).toContain("'sms'");
  });

  it("a claimed number is not resolvable until verified", async () => {
    const code = await link(A(), memberA, NUMBER);
    expect(code).toMatch(/^\d{6}$/);
    expect(await lookupMemberChannel(t.db, "sms", NUMBER)).toBeUndefined();
    const [row] = await listMemberChannels(A(), memberA);
    expect(row).toMatchObject({ platformId: NUMBER, verified: false });
    expect(JSON.stringify(row)).not.toContain("hash");
    const [stored] = await rawRows<{ verification_code_hash: string }>(tenantA, "select verification_code_hash from member_channels");
    expect(stored!.verification_code_hash).toBe(hashChannelCode(tenantA, memberA, NUMBER, code, ENV));
    expect(stored!.verification_code_hash).not.toContain(code);
  });

  it("confirms with the right code, then resolves tenant, member, user and role", async () => {
    const code = await link(A(), memberA, NUMBER);
    const result = await confirmChannelVerification(A(), { memberId: memberA, channel: "sms", platformId: NUMBER, code }, { now: new Date(now.getTime() + 60_000), source: ENV });
    expect(result).toMatchObject({ ok: true, channel: { verified: true, verificationExpiresAt: null } });
    expect(await lookupMemberChannel(t.db, "sms", NUMBER)).toEqual({ tenantId: tenantA, memberId: memberA, userId: ownerA, role: "owner" });
    expect(await lookupMemberChannel(t.db, "sms", "+15559999999")).toBeUndefined();
    const [stored] = await rawRows<{ verification_code_hash: string | null }>(tenantA, "select verification_code_hash from member_channels where verified_at is not null");
    expect(stored!.verification_code_hash).toBeNull();
  });

  it("a verified number cannot be claimed by another household or member", async () => {
    expect(await startChannelVerification(B(), { memberId: memberB, channel: "sms", platformId: NUMBER }, { now, source: ENV })).toEqual({ ok: false, reason: "taken" });
    expect(await startChannelVerification(A(), { memberId: kidA, channel: "sms", platformId: NUMBER }, { now, source: ENV })).toEqual({ ok: false, reason: "taken" });
  });

  it("RLS hides another household's channels", async () => {
    expect(await listMemberChannels(B(), memberA)).toEqual([]);
    expect(await removeMemberChannel(B(), memberA, (await listMemberChannels(A(), memberA))[0]!.id)).toBe(false);
    expect(await startChannelVerification(B(), { memberId: memberA, channel: "sms", platformId: "+15550000001" }, { now, source: ENV })).toEqual({ ok: false, reason: "no_member" });
  });

  it("a member without an account resolves with a null user and the member role", async () => {
    const other = "+15551230002";
    const code = await link(A(), kidA, other);
    await confirmChannelVerification(A(), { memberId: kidA, channel: "sms", platformId: other, code }, { now, source: ENV });
    expect(await lookupMemberChannel(t.db, "sms", other)).toEqual({ tenantId: tenantA, memberId: kidA, userId: null, role: "member" });
  });

  it("wrong codes spend persisted attempts; the last one burns the code", async () => {
    const num = "+15551230003";
    const code = await link(B(), memberB, num);
    const wrong = code === "000000" ? "000001" : "000000";
    for (let i = 1; i < CHANNEL_CODE_MAX_ATTEMPTS; i++) {
      expect(await confirmChannelVerification(B(), { memberId: memberB, channel: "sms", platformId: num, code: wrong }, { now, source: ENV })).toEqual({ ok: false, reason: "invalid" });
    }
    expect(await confirmChannelVerification(B(), { memberId: memberB, channel: "sms", platformId: num, code: wrong }, { now, source: ENV })).toEqual({ ok: false, reason: "too_many_attempts" });
    // Even the right code no longer works.
    expect(await confirmChannelVerification(B(), { memberId: memberB, channel: "sms", platformId: num, code }, { now, source: ENV })).toEqual({ ok: false, reason: "not_found" });
    expect(await lookupMemberChannel(t.db, "sms", num)).toBeUndefined();
    // A new code resets the counter.
    const fresh = await link(B(), memberB, num);
    expect(await confirmChannelVerification(B(), { memberId: memberB, channel: "sms", platformId: num, code: fresh }, { now, source: ENV })).toMatchObject({ ok: true });
  });

  it("an expired code is refused and cleared", async () => {
    const num = "+15551230004";
    const code = await link(B(), memberB, num);
    const late = new Date(now.getTime() + CHANNEL_CODE_TTL_MS + 1);
    expect(await confirmChannelVerification(B(), { memberId: memberB, channel: "sms", platformId: num, code }, { now: late, source: ENV })).toEqual({ ok: false, reason: "expired" });
    expect(await confirmChannelVerification(B(), { memberId: memberB, channel: "sms", platformId: num, code }, { now, source: ENV })).toEqual({ ok: false, reason: "not_found" });
    expect(await lookupMemberChannel(t.db, "sms", num)).toBeUndefined();
  });

  it("caps channels per member, then removing one frees a slot and unlinks the number", async () => {
    // memberB holds two verified/pending numbers already (+3, +4); fill to the cap.
    const extra: string[] = [];
    for (let i = 0; i < MAX_CHANNELS_PER_MEMBER; i++) {
      const n = `+1555123010${i}`;
      const r = await startChannelVerification(B(), { memberId: memberB, channel: "sms", platformId: n }, { now, source: ENV });
      if (r.ok) extra.push(n);
    }
    expect(await startChannelVerification(B(), { memberId: memberB, channel: "sms", platformId: "+15551239999" }, { now, source: ENV })).toEqual({ ok: false, reason: "limit" });
    const rows = await listMemberChannels(B(), memberB);
    expect(rows).toHaveLength(MAX_CHANNELS_PER_MEMBER);
    const verified = rows.find((r) => r.verified)!;
    expect(await lookupMemberChannel(t.db, "sms", verified.platformId)).toBeDefined();
    expect(await removeMemberChannel(B(), memberB, verified.id)).toBe(true);
    expect(await lookupMemberChannel(t.db, "sms", verified.platformId)).toBeUndefined();
  });

  it("the definer function is the only cross-tenant read: a plain select sees nothing without a tenant", async () => {
    const res = await t.client.query("select * from member_channels");
    expect(res.rows).toHaveLength(0);
  });
});
