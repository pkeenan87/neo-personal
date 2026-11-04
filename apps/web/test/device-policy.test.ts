// @vitest-environment node
/**
 * Policy bundles (_specs/v2-m2-child.md section 4, slice 2) on PGlite with the committed migrations:
 * GET /api/devices/policy (auth and scope, ETag/304, the signature cache, 503 without a signer, rate
 * limit, revoked device), GET /api/devices/policy/keys, the heartbeat's policyVersion fields, and the
 * console's per-device pending state.
 */
import { devices, policyBundles, tenantScoped } from "@neo/db";
import { verifyPolicyEnvelope, type PolicyEnvelope } from "@neo/verdict";
import { eq } from "drizzle-orm";
import type { Session } from "next-auth";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as enrollPOST } from "@/app/api/devices/enroll/route";
import { POST as heartbeatPOST } from "@/app/api/devices/heartbeat/route";
import { GET as policyGET } from "@/app/api/devices/policy/route";
import { GET as keysGET } from "@/app/api/devices/policy/keys/route";
import { PATCH } from "@/app/api/household/protected-members/[id]/route";
import { POST as memberCodesPOST } from "@/app/api/household/protected-members/[id]/enrollment-codes/route";
import { PUT as POLICY } from "@/app/api/household/protected-members/[id]/policy/route";
import { POST as CREATE } from "@/app/api/household/protected-members/route";
import { PUT as TIME_ZONE } from "@/app/api/household/time-zone/route";
import type { CreateEnrollmentCodeResponse, EnrollDeviceResponse, HeartbeatResponse } from "@/lib/household-types";
import type { MemberDetailResponse } from "@/lib/member-types";
import { CONSENT_TEXT_VERSION } from "@/lib/consent-text";
import { householdDevices } from "@/lib/server/device-enrollment";
import { getMemberDetail } from "@/lib/server/member-console";
import { POLICY_LIMIT, devicePolicyState, servePolicy } from "@/lib/server/policy-bundles";
import { getPolicySigningService, setPolicySigningServiceForTests, type PolicySigningService } from "@/lib/server/policy-signer";
import { revokeDevice } from "@/lib/server/devices";
import { memorySentEmails } from "@/lib/server/email/resend";
import { resetRateLimits } from "@/lib/server/rate-limit";
import { getSession, requireDeviceSession } from "@/lib/session";
import { createEveFixture, type EveFixture, type Person } from "./helpers/eve-db";
import { post, resetMemoryState, stubBaseEnv } from "./helpers/routes";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/server/db", () => ({ getDb: () => holder.db }));
const hdrs = vi.hoisted(() => ({ current: new Headers() }));
vi.mock("next/headers", () => ({
  headers: async () => hdrs.current,
  cookies: async () => ({ get: () => undefined, getAll: () => [] }),
}));
const authState = vi.hoisted(() => ({ session: null as Session | null }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => authState.session) }));

let fx: EveFixture;
let sam: string; // a child without an account, Child mode, 10-13 band
let gran: string; // a member without an account, Standard
let samDevice: { token: string; deviceId: string };
let granDevice: { token: string; deviceId: string };
const thisYear = new Date().getUTCFullYear();
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const json = (url: string, method: string, body: unknown) => new Request(`http://localhost${url}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

function as(p: Person): void {
  hdrs.current = new Headers();
  const name = p.deviceName.split("'")[0]!;
  authState.session = { userId: p.userId, tenantId: p.tenantId, role: p.role, user: { email: `${name.toLowerCase()}@example.test`, name }, expires: "2099-01-01T00:00:00Z" };
}
function bearer(token: string): void {
  authState.session = null;
  hdrs.current = new Headers({ authorization: `Bearer ${token}` });
}
function anonymous(): void {
  authState.session = null;
  hdrs.current = new Headers();
}

async function addMember(body: unknown): Promise<string> {
  as(fx.owner);
  const res = await CREATE(json("/api/household/protected-members", "POST", body));
  expect(res.status).toBe(201);
  return ((await res.json()) as MemberDetailResponse).member.id;
}

async function enrollFor(memberId: string): Promise<{ token: string; deviceId: string }> {
  as(fx.owner);
  const made = await memberCodesPOST(post(`/api/household/protected-members/${memberId}/enrollment-codes`, {}), params(memberId));
  expect(made.status).toBe(201);
  const { code } = (await made.json()) as CreateEnrollmentCodeResponse;
  anonymous();
  const res = await enrollPOST(
    new Request("http://localhost/api/devices/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 250)}` },
      body: JSON.stringify({ code, kind: "browser_extension", platform: "chrome", name: "Chrome", clientVersion: "1.0.0" }),
    }),
  );
  expect(res.status).toBe(201);
  const enrolled = (await res.json()) as EnrollDeviceResponse;
  return { token: enrolled.token, deviceId: enrolled.device.id };
}

function getPolicy(token: string, headers: Record<string, string> = {}): Promise<Response> {
  bearer(token);
  hdrs.current = new Headers({ authorization: `Bearer ${token}`, ...headers });
  return policyGET(new Request("http://localhost/api/devices/policy", { headers }));
}

async function envelopeOf(res: Response): Promise<PolicyEnvelope> {
  expect(res.status).toBe(200);
  return (await res.json()) as PolicyEnvelope;
}

/** The real (ephemeral) signer with its calls counted, installed as the policy signer. */
function spySigner(over: { keyId?: string } = {}): { service: PolicySigningService; calls: () => number } {
  setPolicySigningServiceForTests(undefined);
  const real = getPolicySigningService()!;
  let n = 0;
  const service: PolicySigningService = {
    kind: real.kind,
    sign: async (bytes) => {
      n += 1;
      const s = await real.sign(bytes);
      return over.keyId ? { ...s, keyId: over.keyId } : s;
    },
    currentKeyId: async () => over.keyId ?? (await real.currentKeyId()),
    publicKeys: () => real.publicKeys(),
  };
  setPolicySigningServiceForTests(service);
  return { service, calls: () => n };
}

async function setMemberPolicy(memberId: string, body: unknown): Promise<void> {
  as(fx.owner);
  const res = await POLICY(json(`/api/household/protected-members/${memberId}/policy`, "PUT", body), params(memberId));
  expect(res.status).toBe(200);
}

beforeAll(async () => {
  fx = await createEveFixture();
  holder.db = fx.db;
  stubBaseEnv(vi);
  vi.stubEnv("DEV_AUTH_BYPASS", "false");
  vi.stubEnv("AUTH_URL", "https://neo.example.test");
  as(fx.owner);
  expect((await TIME_ZONE(json("/api/household/time-zone", "PUT", { timeZone: "America/New_York" }))).status).toBe(200);
  sam = await addMember({ displayName: "Sam", role: "child", birthYear: thisYear - 12 });
  const turnedOn = await PATCH(json(`/api/household/protected-members/${sam}`, "PATCH", { mode: "child", consentTextVersion: CONSENT_TEXT_VERSION }), params(sam));
  expect(turnedOn.status).toBe(200);
  gran = await addMember({ displayName: "Gran", role: "elder" });
  samDevice = await enrollFor(sam);
  granDevice = await enrollFor(gran);
  vi.unstubAllEnvs();
}, 60_000);
afterAll(async () => {
  await fx.close();
});
beforeEach(async () => {
  holder.db = fx.db;
  // Every test starts without a stored signature.
  await tenantScoped(fx.db, fx.owner.tenantId).delete(policyBundles);
  stubBaseEnv(vi);
  vi.stubEnv("DEV_AUTH_BYPASS", "false");
  vi.stubEnv("INNGEST_EVENT_KEY", "");
  vi.stubEnv("AUTH_URL", "https://neo.example.test");
  vi.stubEnv("NEO_POLICY_KMS_ISSUER", "");
  vi.stubEnv("NEO_POLICY_SIGNING_KEY", "");
  resetMemoryState();
  resetRateLimits();
  memorySentEmails().length = 0;
  setPolicySigningServiceForTests(undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  setPolicySigningServiceForTests(undefined);
});

describe("GET /api/devices/policy: who may call it", () => {
  it("is 401 without a token and 403 for a browser session", async () => {
    anonymous();
    expect((await policyGET(new Request("http://localhost/api/devices/policy"))).status).toBe(401);
    as(fx.owner);
    const browser = await policyGET(new Request("http://localhost/api/devices/policy"));
    expect(browser.status).toBe(403);
    expect(await browser.json()).toMatchObject({ code: "insufficient_scope" });
  });

  it("takes the member from the device: Sam's token gets Sam's Child bundle, Gran's the empty Standard one", async () => {
    const child = await envelopeOf(await getPolicy(samDevice.token));
    expect(child.bundle).toMatchObject({ v: 1, deviceId: samDevice.deviceId, memberId: sam, mode: "child", timeZone: "America/New_York" });
    expect(child.bundle.web.categories.length).toBeGreaterThan(0);
    expect(child.bundle.screenTime.dailyMinutes.mon).toBe(120);
    const standard = await envelopeOf(await getPolicy(granDevice.token));
    expect(standard.bundle).toMatchObject({ deviceId: granDevice.deviceId, memberId: gran, mode: "standard" });
    expect(standard.bundle.web).toEqual({ categories: [], safeSearch: false, youtubeRestricted: "off", allow: [], block: [] });
    expect(standard.bundle.apps).toEqual({ block: [], requireApproval: false, approved: [] });
    expect(standard.bundle.screenTime.downtime).toEqual([]);
  });
});

describe("GET /api/devices/policy: the response", () => {
  it("carries an ETag of the policy version, no-cache, and a signature that verifies with the published key", async () => {
    const res = await getPolicy(samDevice.token);
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    const env = await envelopeOf(res);
    expect(res.headers.get("etag")).toBe(`"${env.bundle.policyVersion}"`);
    expect(env.alg).toBe("ES256");
    const keys = await (await keysGET()).json();
    expect(keys.keys).toHaveLength(1);
    expect(keys.keys[0]).toMatchObject({ kid: env.keyId, alg: "ES256" });
    expect(await verifyPolicyEnvelope(env, keys.keys)).toMatchObject({ ok: true });
    expect((new Date(env.bundle.expiresAt).getTime() - new Date(env.bundle.issuedAt).getTime()) / 86_400_000).toBe(7);
  });

  it("answers 304 with the ETag on a matching If-None-Match (quoted, weak and in a list) without signing", async () => {
    const spy = spySigner();
    const first = await getPolicy(samDevice.token);
    const env = await envelopeOf(first);
    const calls = spy.calls();
    const etag = `"${env.bundle.policyVersion}"`;
    for (const header of [etag, `W/${etag}`, `"zzz", ${etag}`]) {
      const res = await getPolicy(samDevice.token, { "if-none-match": header });
      expect(res.status).toBe(304);
      expect(res.headers.get("etag")).toBe(etag);
      expect(res.headers.get("cache-control")).toBe("private, no-cache");
      expect(await res.text()).toBe("");
    }
    expect(spy.calls()).toBe(calls);
    expect((await getPolicy(samDevice.token, { "if-none-match": '"stale"' })).status).toBe(200);
  });
});

describe("the signature cache", () => {
  it("signs once for two requests with the same version, again after a rule change, and stores the row", async () => {
    const spy = spySigner();
    const a = await envelopeOf(await getPolicy(granDevice.token));
    const b = await envelopeOf(await getPolicy(granDevice.token));
    expect(spy.calls()).toBe(1);
    expect(b).toEqual(a);
    const stored = await tenantScoped(fx.db, fx.owner.tenantId).first(policyBundles, eq(policyBundles.deviceId, granDevice.deviceId));
    expect(stored).toMatchObject({ policyVersion: a.bundle.policyVersion, keyId: a.keyId, sig: a.sig });
    expect(stored?.bundle).toEqual(a.bundle);

    // A rule change that shows up in the bundle (Sam is in Child mode; use his device).
    const s1 = await envelopeOf(await getPolicy(samDevice.token));
    expect(spy.calls()).toBe(2);
    await setMemberPolicy(sam, { web: { block: ["games.example.com"] } });
    const s2 = await envelopeOf(await getPolicy(samDevice.token));
    expect(spy.calls()).toBe(3);
    expect(s2.bundle.policyVersion).not.toBe(s1.bundle.policyVersion);
    expect(s2.bundle.web.block).toEqual(["games.example.com"]);
    expect((await verifyPolicyEnvelope(s2, (await getPolicySigningService()!.publicKeys()))).ok).toBe(true);
    // Unchanged again: served from the row.
    await getPolicy(samDevice.token);
    expect(spy.calls()).toBe(3);
    await setMemberPolicy(sam, { web: null });
  });

  it("re-signs when the stored bundle is within a day of expiring, or was made by another key", async () => {
    const spy = spySigner();
    anonymous();
    bearer(samDevice.token);
    const { session } = await requireDeviceSession("device");
    const start = new Date();
    const first = await servePolicy(session!, null, start);
    expect(first).toMatchObject({ ok: true, status: 200 });
    const calls = spy.calls();
    // Five days on: more than a day left on the stored bundle (issued then, expires in seven).
    await servePolicy(session!, null, new Date(start.getTime() + 5 * 86_400_000));
    expect(spy.calls()).toBe(calls);
    // Six and a half days on: under a day left, so a fresh signature with new timestamps.
    const later = new Date(start.getTime() + 6.5 * 86_400_000);
    const renewed = await servePolicy(session!, null, later);
    expect(spy.calls()).toBe(calls + 1);
    expect(renewed).toMatchObject({ ok: true, status: 200, envelope: { bundle: { issuedAt: later.toISOString() } } });
    // Another key id (a rotation): the stored signature is not reused.
    const rotated = spySigner({ keyId: "rotated-key" });
    const r = await servePolicy(session!, null, later);
    expect(rotated.calls()).toBe(1);
    expect(r).toMatchObject({ ok: true, envelope: { keyId: "rotated-key" } });
  });
});

describe("no signer", () => {
  it("answers 503 policy_signing_unavailable on a production deployment with nothing configured, and serves no bundle", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    const res = await getPolicy(samDevice.token);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "policy_signing_unavailable" });
    expect((await getPolicy(samDevice.token, { "if-none-match": '"anything"' })).status).toBe(503);
    const keys = await keysGET();
    expect(keys.status).toBe(503);
    vi.stubEnv("VERCEL_ENV", "preview");
    expect((await getPolicy(samDevice.token)).status).toBe(503);
  });
});

describe("limits and revocation", () => {
  it("allows 120 a hour per device and then answers 429", async () => {
    resetRateLimits();
    const spy = spySigner();
    bearer(granDevice.token);
    for (let i = 0; i < POLICY_LIMIT.limit; i++) {
      const res = await getPolicy(granDevice.token, { "if-none-match": '"x"' });
      expect(res.status).toBe(200);
    }
    const res = await getPolicy(granDevice.token);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(spy.calls()).toBeLessThanOrEqual(1);
    // The bucket is per device: Sam's is untouched.
    expect((await getPolicy(samDevice.token)).status).toBe(200);
  }, 30_000); // 121 requests through PGlite: slow on shared CI runners

  it("answers 404 for a device revoked after its token resolved, and 401 for the token once it is revoked", async () => {
    const extra = await enrollFor(gran);
    bearer(extra.token);
    const { session } = await requireDeviceSession("device");
    expect(session?.deviceId).toBe(extra.deviceId);
    // Revoke the device row only, leaving the token live: the race the 404 covers.
    await tenantScoped(fx.db, fx.owner.tenantId).update(devices, { revokedAt: new Date() }, eq(devices.id, extra.deviceId));
    expect(await servePolicy(session!, null)).toMatchObject({ ok: false, status: 404, code: "not_found" });
    // A full revoke takes the token with it.
    await revokeDevice({ tenantId: fx.owner.tenantId, deviceId: extra.deviceId, revokedBy: fx.owner.userId });
    expect((await getPolicy(extra.token)).status).toBe(401);
  });
});

describe("keys endpoint", () => {
  it("needs no authentication, is cacheable for an hour, and lists the public JWK", async () => {
    anonymous();
    const res = await keysGET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    const body = (await res.json()) as { keys: { kid: string; alg: string; jwk: Record<string, string> }[] };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]!.jwk).toMatchObject({ kty: "EC", crv: "P-256" });
    expect(body.keys[0]!.jwk).not.toHaveProperty("d");
  });
});

describe("heartbeat", () => {
  async function heartbeat(token: string, body: unknown = {}): Promise<Response> {
    bearer(token);
    return heartbeatPOST(post("/api/devices/heartbeat", body));
  }
  const stored = async (deviceId: string) => (await tenantScoped(fx.db, fx.owner.tenantId).first(devices, eq(devices.id, deviceId)))?.policyVersionApplied;

  it("returns the current policy version, the one GET /api/devices/policy serves", async () => {
    const res = await heartbeat(samDevice.token);
    expect(res.status).toBe(200);
    const hb = (await res.json()) as HeartbeatResponse;
    const env = await envelopeOf(await getPolicy(samDevice.token));
    expect(hb.policyVersion).toBe(env.bundle.policyVersion);
    expect(hb.listsVersion).toBeTruthy();
  });

  it("stores the applied version, keeps it when a later heartbeat omits it, and lowercases it", async () => {
    expect(await stored(samDevice.deviceId)).toBeNull();
    expect((await heartbeat(samDevice.token, { clientVersion: "1.0.1" })).status).toBe(200);
    expect(await stored(samDevice.deviceId)).toBeNull();
    expect((await heartbeat(samDevice.token, { policyVersion: "ABCDEF0123" })).status).toBe(200);
    expect(await stored(samDevice.deviceId)).toBe("abcdef0123");
    expect((await heartbeat(samDevice.token, {})).status).toBe(200);
    expect(await stored(samDevice.deviceId)).toBe("abcdef0123");
    expect((await heartbeat(samDevice.token, { policyVersion: "" })).status).toBe(200);
    expect(await stored(samDevice.deviceId)).toBe("abcdef0123");
  });

  it("rejects a non-hex, over-long or non-string policyVersion with 400 and stores nothing", async () => {
    for (const bad of ["not hex!", "a".repeat(65), 12, ["ab"], { v: 1 }]) {
      const res = await heartbeat(samDevice.token, { policyVersion: bad });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "invalid" });
    }
    expect(await stored(samDevice.deviceId)).toBe("abcdef0123");
  });
});

describe("the member page's device state", () => {
  it("maps applied and current versions to the badge", () => {
    expect(devicePolicyState("child", null, "abc")).toBe("update_needed");
    expect(devicePolicyState("standard", null, "abc")).toBe("current");
    expect(devicePolicyState("child", "abc", "abc")).toBe("current");
    expect(devicePolicyState("child", "old", "abc")).toBe("pending");
    expect(devicePolicyState("standard", "old", "abc")).toBe("pending");
    expect(devicePolicyState("child", "abc", null)).toBe("unknown");
  });

  it("lists the member's devices: pending after a rule change, current once the device reports the new version", async () => {
    const detailOf = async (id: string) => {
      const r = await getMemberDetail({ ...fx.owner, userId: fx.owner.userId, tenantId: fx.owner.tenantId, role: "owner" } as never, id);
      if (!r.ok) throw new Error(r.code);
      return r.value;
    };
    const env0 = await envelopeOf(await getPolicy(samDevice.token));
    await tenantScoped(fx.db, fx.owner.tenantId).update(devices, { policyVersionApplied: null }, eq(devices.id, samDevice.deviceId));
    expect((await detailOf(sam)).devices).toEqual([expect.objectContaining({ id: samDevice.deviceId, policy: "update_needed" })]);

    await tenantScoped(fx.db, fx.owner.tenantId).update(devices, { policyVersionApplied: env0.bundle.policyVersion }, eq(devices.id, samDevice.deviceId));
    expect((await detailOf(sam)).devices?.[0]?.policy).toBe("current");

    await setMemberPolicy(sam, { web: { block: ["pending.example.com"] } });
    expect((await detailOf(sam)).devices?.[0]?.policy).toBe("pending");
    const env1 = await envelopeOf(await getPolicy(samDevice.token));
    bearer(samDevice.token);
    expect((await heartbeatPOST(post("/api/devices/heartbeat", { policyVersion: env1.bundle.policyVersion }))).status).toBe(200);
    expect((await detailOf(sam)).devices?.[0]?.policy).toBe("current");
    // A Standard member whose device never reported a version is not nagged.
    expect((await detailOf(gran)).devices?.every((d) => d.policy !== "update_needed")).toBe(true);
    await setMemberPolicy(sam, { web: null });
    expect(await getSession({ scope: "device" })).not.toBeUndefined();
  });

  it("shows the same state in the household devices list", async () => {
    const env = await envelopeOf(await getPolicy(samDevice.token));
    const listFor = async () => {
      const home = await householdDevices({ userId: fx.owner.userId, tenantId: fx.owner.tenantId, role: "owner" } as never);
      return Object.fromEntries(home.devices.map((d) => [d.id, d.policy]));
    };
    await tenantScoped(fx.db, fx.owner.tenantId).update(devices, { policyVersionApplied: null }, eq(devices.id, samDevice.deviceId));
    expect((await listFor())[samDevice.deviceId]).toBe("update_needed");
    await tenantScoped(fx.db, fx.owner.tenantId).update(devices, { policyVersionApplied: "0123abcd" }, eq(devices.id, samDevice.deviceId));
    expect((await listFor())[samDevice.deviceId]).toBe("pending");
    await tenantScoped(fx.db, fx.owner.tenantId).update(devices, { policyVersionApplied: env.bundle.policyVersion }, eq(devices.id, samDevice.deviceId));
    expect((await listFor())[samDevice.deviceId]).toBe("current");
  });
});
