// @vitest-environment node
/**
 * "Connect a phone (SMS)" console routes (_specs/v2-m3-cutover.md section 5) on PGlite with the committed
 * migrations: owner only, flag-gated (404 when off), code stored hashed, 10-minute expiry, 5 attempts, a
 * mock sender that never reaches the network, audit events without the number, rate limits.
 */
import { auditEvents, memberChannels, members, tenantScoped } from "@neo/db";
import type { Session } from "next-auth";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE } from "@/app/api/household/protected-members/[id]/channels/[channelId]/route";
import { GET, POST } from "@/app/api/household/protected-members/[id]/channels/route";
import { POST as VERIFY } from "@/app/api/household/protected-members/[id]/channels/verify/route";
import { resetMemoryChannels, resolveSmsCaller } from "@/lib/server/member-channels";
import { mockSentSms, resetMockSentSms } from "@/lib/server/sms-sender";
import { createEveFixture, type EveFixture, type Person } from "./helpers/eve-db";
import { resetMemoryState, stubBaseEnv } from "./helpers/routes";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/server/db", () => ({ getDb: () => holder.db }));
const hdrs = vi.hoisted(() => ({ current: new Headers() }));
vi.mock("next/headers", () => ({
  headers: async () => hdrs.current,
  cookies: async () => ({ get: () => undefined, getAll: () => [] }),
}));
const authState = vi.hoisted(() => ({ session: null as Session | null }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => authState.session) }));

type Channels = { channels: { id: string; display: string; verified: boolean; verificationExpiresAt: string | null }[] };

let fx: EveFixture;
let fetchSpy: ReturnType<typeof vi.fn>;
beforeAll(async () => {
  fx = await createEveFixture();
}, 60_000);
afterAll(async () => {
  await fx.close();
});
beforeEach(() => {
  holder.db = fx.db;
  stubBaseEnv(vi);
  vi.stubEnv("DEV_AUTH_BYPASS", "false");
  vi.stubEnv("NEO_TWILIO_ENABLED", "true");
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  resetMockSentSms();
  resetMemoryChannels();
  (globalThis as { __neoRateBuckets?: unknown }).__neoRateBuckets = undefined;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetMemoryState();
});

function as(p: Person): void {
  hdrs.current = new Headers();
  const name = p.deviceName.split("'")[0]!;
  authState.session = { userId: p.userId, tenantId: p.tenantId, role: p.role, user: { email: `${name.toLowerCase()}@example.test`, name }, expires: "2099-01-01T00:00:00Z" };
}

const params = (id: string, channelId?: string) => ({ params: Promise.resolve({ id, channelId: channelId ?? "" }) });
const json = (url: string, method: string, body: unknown) =>
  new Request(`http://localhost${url}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const url = (id: string) => `/api/household/protected-members/${id}/channels`;
const start = (id: string, phone: string) => POST(json(url(id), "POST", { phone }), params(id));
const verify = (id: string, phone: string, code: string) => VERIFY(json(`${url(id)}/verify`, "POST", { phone, code }), params(id));
const list = async (id: string) => (await (await GET(new Request("http://localhost/x"), params(id))).json()) as Channels;
const lastCode = () => /\b(\d{6})\b/.exec(mockSentSms().at(-1)?.body ?? "")?.[1] ?? "";
const audit = async (type: string) => tenantScoped(fx.db, fx.owner.tenantId).select(auditEvents).then((rows) => rows.filter((r) => r.eventType === type));
const PHONE = "+15557770001";

describe("connect a phone", () => {
  it("is 404 for every route while the flag is off", async () => {
    vi.stubEnv("NEO_TWILIO_ENABLED", "");
    as(fx.owner);
    expect((await start(fx.kid.memberId, PHONE)).status).toBe(404);
    expect((await GET(new Request("http://localhost/x"), params(fx.kid.memberId))).status).toBe(404);
    expect((await verify(fx.kid.memberId, PHONE, "123456")).status).toBe(404);
    expect((await DELETE(new Request("http://localhost/x", { method: "DELETE" }), params(fx.kid.memberId, crypto.randomUUID()))).status).toBe(404);
    expect(mockSentSms()).toHaveLength(0);
  });

  it("is owner only: a member gets 403, another household's owner 404, nobody 401", async () => {
    as(fx.kid);
    expect((await start(fx.kid.memberId, PHONE)).status).toBe(403);
    as(fx.other);
    expect((await start(fx.kid.memberId, PHONE)).status).toBe(404);
    authState.session = null;
    expect((await start(fx.kid.memberId, PHONE)).status).toBe(401);
    expect(mockSentSms()).toHaveLength(0);
  });

  it("stores a hashed code, 'sends' it through the mock only, and verifies it; then the number resolves", async () => {
    as(fx.owner);
    const res = await start(fx.kid.memberId, "+1 (555) 777-0001");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Channels;
    expect(body.channels).toHaveLength(1);
    expect(body.channels[0]).toMatchObject({ display: "+• ••• 0001", verified: false });
    expect(JSON.stringify(body)).not.toContain("5557770001");
    expect(Date.parse(body.channels[0]!.verificationExpiresAt!)).toBeGreaterThan(Date.now() + 9 * 60_000);

    expect(mockSentSms()).toHaveLength(1);
    expect(mockSentSms()[0]).toMatchObject({ to: PHONE, purpose: "verification_code" });
    const code = lastCode();
    expect(code).toMatch(/^\d{6}$/);
    expect(fetchSpy).not.toHaveBeenCalled();

    const [stored] = await tenantScoped(fx.db, fx.owner.tenantId).select(memberChannels);
    expect(stored!.verificationCodeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored!.verificationCodeHash).not.toContain(code);
    expect(await resolveSmsCaller(PHONE)).toBeNull();

    const ok = await verify(fx.kid.memberId, PHONE, code);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as Channels).channels[0]).toMatchObject({ verified: true, verificationExpiresAt: null });
    expect(await resolveSmsCaller(PHONE)).toMatchObject({ tenantId: fx.owner.tenantId, memberId: fx.kid.memberId, userId: fx.kid.userId, role: "member" });

    // Audit events carry a hash of the number, never the number or the code.
    const sent = await audit("member.channel_code_sent");
    const verified = await audit("member.channel_verified");
    expect(sent).toHaveLength(1);
    expect(verified).toHaveLength(1);
    const all = JSON.stringify([sent, verified]);
    expect(all).not.toContain("5557770001");
    expect(all).not.toContain(code);
    expect(sent[0]!.metadata).toMatchObject({ memberId: fx.kid.memberId, channel: "sms", phoneHash: expect.stringMatching(/^[0-9a-f]{16}$/) });
  });

  it("rejects a wrong code, burns it after five, and expires it after ten minutes", async () => {
    as(fx.owner);
    await start(fx.kid.memberId, "+15557770002");
    const code = lastCode();
    const wrong = code === "000000" ? "000001" : "000000";
    for (let i = 0; i < 4; i++) {
      const r = await verify(fx.kid.memberId, "+15557770002", wrong);
      expect(r.status).toBe(400);
      expect(((await r.json()) as { code: string }).code).toBe("invalid_code");
    }
    expect((await verify(fx.kid.memberId, "+15557770002", wrong)).status).toBe(429);
    expect((await verify(fx.kid.memberId, "+15557770002", code)).status).toBe(404); // burned
    expect(await resolveSmsCaller("+15557770002")).toBeNull();
    expect((await audit("member.channel_verify_failed")).length).toBeGreaterThanOrEqual(5);

    await start(fx.kid.memberId, "+15557770002"); // a fresh code resets the counter
    const fresh = lastCode();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 10 * 60_000 + 1000);
      const late = await verify(fx.kid.memberId, "+15557770002", fresh);
      expect(late.status).toBe(410);
    } finally {
      vi.useRealTimers();
    }
    expect(await resolveSmsCaller("+15557770002")).toBeNull();
  });

  it("validates the number and the code", async () => {
    as(fx.owner);
    for (const bad of ["5557770001", "+1", "hello", ""]) expect((await start(fx.kid.memberId, bad)).status, bad).toBe(400);
    expect((await POST(json(url(fx.kid.memberId), "POST", { phone: PHONE, extra: 1 }), params(fx.kid.memberId))).status).toBe(400);
    expect((await verify(fx.kid.memberId, PHONE, "12ab56")).status).toBe(400);
    expect(mockSentSms()).toHaveLength(0);
  });

  it("will not let a second household claim a verified number, and says nothing about who has it", async () => {
    as(fx.owner);
    await start(fx.owner.memberId, "+15557770003");
    await verify(fx.owner.memberId, "+15557770003", lastCode());
    as(fx.other);
    const r = await start(fx.other.memberId, "+15557770003");
    expect(r.status).toBe(409);
    expect(JSON.stringify(await r.json())).not.toContain(fx.owner.tenantId);
  });

  it("disconnects a phone and the number stops resolving; another household cannot remove it", async () => {
    as(fx.owner);
    await start(fx.owner.memberId, "+15557770004");
    await verify(fx.owner.memberId, "+15557770004", lastCode());
    const [row] = (await list(fx.owner.memberId)).channels.filter((c) => c.verified && c.display.endsWith("0004"));
    expect(await resolveSmsCaller("+15557770004")).not.toBeNull();
    as(fx.other);
    expect((await DELETE(new Request("http://localhost/x", { method: "DELETE" }), params(fx.owner.memberId, row!.id))).status).toBe(404);
    as(fx.owner);
    expect((await DELETE(new Request("http://localhost/x", { method: "DELETE" }), params(fx.owner.memberId, row!.id))).status).toBe(200);
    expect(await resolveSmsCaller("+15557770004")).toBeNull();
    expect((await audit("member.channel_removed")).length).toBe(1);
  });

  it("caps the phones per person and rate limits code requests", async () => {
    as(fx.owner);
    const [fresh] = await tenantScoped(fx.db, fx.owner.tenantId).insert(members, { userId: null, displayName: "Gran", role: "adult" });
    const gran = fresh!.id;
    for (let i = 0; i < 3; i++) expect((await start(gran, `+1555777010${i}`)).status).toBe(200);
    expect((await start(gran, "+15557770199")).status).toBe(409);
    (globalThis as { __neoRateBuckets?: unknown }).__neoRateBuckets = undefined;
    // Household limit: 5 per 10 minutes (3 used above + the rejected one fails before sending, so count sends).
    let limited = 0;
    for (let i = 0; i < 8; i++) {
      const r = await start(fx.owner.memberId, `+1555777020${i}`);
      if (r.status === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
    // The same number cannot be texted over and over.
    (globalThis as { __neoRateBuckets?: unknown }).__neoRateBuckets = undefined;
    let numberLimited = 0;
    for (let i = 0; i < 5; i++) {
      const r = await start(gran, "+15557770100");
      if (r.status === 429) numberLimited++;
    }
    expect(numberLimited).toBeGreaterThan(0);
  });

  it("works without a database (memory twin) for MOCK_MODE", async () => {
    holder.db = null;
    vi.stubEnv("DEV_AUTH_BYPASS", "false");
    as({ ...fx.owner, memberId: "00000000-0000-4000-8000-000000000000" });
    // No registered memory members: the memory twin has no such member, so it is a 404 rather than a crash.
    expect((await start("00000000-0000-4000-8000-000000000000", PHONE)).status).toBe(404);
  });
});
