// @vitest-environment node
/**
 * Policy bundles on the in-memory stores (MOCK_MODE, no database): the same route, the memory twin of the
 * signature cache, and the heartbeat's version fields (the Postgres path is device-policy.test.ts).
 */
import { verifyPolicyEnvelope, type PolicyEnvelope } from "@neo/verdict";
import type { Session } from "next-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as enrollPOST } from "@/app/api/devices/enroll/route";
import { POST as heartbeatPOST } from "@/app/api/devices/heartbeat/route";
import { GET as policyGET } from "@/app/api/devices/policy/route";
import { POST as codesPOST } from "@/app/api/household/members/[userId]/enrollment-codes/route";
import type { CreateEnrollmentCodeResponse, EnrollDeviceResponse, HeartbeatResponse } from "@/lib/household-types";
import { getDevice } from "@/lib/server/devices";
import { memoryCreateDesktopToken } from "@/lib/server/memory-desktop-tokens";
import { resetMemoryAlerts } from "@/lib/server/memory-alerts";
import { resetMemoryDesktopAuth } from "@/lib/server/memory-desktop-auth";
import { resetMemoryDevices } from "@/lib/server/memory-devices";
import { resetMemoryHousehold } from "@/lib/server/memory-household";
import { memoryInsertMemberPolicy, memorySetHouseholdTimeZone, setMemoryMemberMode } from "@/lib/server/memory-members";
import { setMemoryMembers } from "@/lib/server/memory-state";
import { getPolicySigningService, setPolicySigningServiceForTests, type PolicySigningService } from "@/lib/server/policy-signer";
import { resetRateLimits } from "@/lib/server/rate-limit";
import { post, resetMemoryState, stubBaseEnv } from "./helpers/routes";

const hdrs = vi.hoisted(() => ({ current: new Headers() }));
vi.mock("next/headers", () => ({
  headers: async () => hdrs.current,
  cookies: async () => ({ get: () => undefined, getAll: () => [] }),
}));
const authState = vi.hoisted(() => ({ session: null as Session | null }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => authState.session) }));

const TENANT = "00000000-0000-4000-8000-0000000000a1";
const OWNER = { userId: "user-owner", role: "owner" as const, email: "pat@example.test", name: "Pat" };
const KID = { userId: "user-kid", email: "kid@example.test", name: "Kid" };

let token: string;
let deviceId: string;
let memberId: string;
let signCalls = 0;

function spy(): void {
  setPolicySigningServiceForTests(undefined);
  const real = getPolicySigningService()!;
  const service: PolicySigningService = { ...real, sign: async (b) => { signCalls += 1; return real.sign(b); } };
  setPolicySigningServiceForTests(service);
}

function get(headers: Record<string, string> = {}): Promise<Response> {
  authState.session = null;
  hdrs.current = new Headers({ authorization: `Bearer ${token}`, ...headers });
  return policyGET(new Request("http://localhost/api/devices/policy", { headers }));
}

beforeEach(async () => {
  stubBaseEnv(vi);
  vi.stubEnv("DEV_AUTH_BYPASS", "false");
  vi.stubEnv("INNGEST_EVENT_KEY", "");
  vi.stubEnv("AUTH_URL", "https://neo.example.test");
  vi.stubEnv("NEO_POLICY_KMS_ISSUER", "");
  vi.stubEnv("NEO_POLICY_SIGNING_KEY", "");
  resetMemoryState();
  resetMemoryAlerts();
  resetMemoryHousehold();
  resetMemoryDevices();
  resetMemoryDesktopAuth();
  resetRateLimits();
  signCalls = 0;
  const g = globalThis as { __neoDesktopTokens?: unknown };
  g.__neoDesktopTokens = undefined;
  setMemoryMembers(TENANT, [
    { userId: OWNER.userId, name: OWNER.name, email: OWNER.email, role: "owner" },
    { userId: KID.userId, name: KID.name, email: KID.email, role: "member" },
  ]);
  setMemoryMemberMode(TENANT, KID.userId, "child");
  memorySetHouseholdTimeZone(TENANT, "America/Chicago");
  authState.session = { userId: OWNER.userId, tenantId: TENANT, role: "owner", user: { email: OWNER.email, name: OWNER.name }, expires: "2099-01-01T00:00:00Z" };
  hdrs.current = new Headers();
  const made = await codesPOST(post(`/api/household/members/${KID.userId}/enrollment-codes`, {}), { params: Promise.resolve({ userId: KID.userId }) });
  const { code } = (await made.json()) as CreateEnrollmentCodeResponse;
  authState.session = null;
  const res = await enrollPOST(
    new Request("http://localhost/api/devices/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.9" },
      body: JSON.stringify({ code, kind: "desktop_agent", platform: "windows", name: "Kid PC", clientVersion: "1.0.0" }),
    }),
  );
  const enrolled = (await res.json()) as EnrollDeviceResponse;
  token = enrolled.token;
  deviceId = enrolled.device.id;
  spy();
});
afterEach(() => {
  vi.unstubAllEnvs();
  setPolicySigningServiceForTests(undefined);
});

describe("GET /api/devices/policy on memory stores", () => {
  it("serves a verifiable Child bundle, caches the signature, and signs again after a rule change", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const env = (await res.json()) as PolicyEnvelope;
    expect(env.bundle).toMatchObject({ deviceId, mode: "child", timeZone: "America/Chicago" });
    memberId = env.bundle.memberId;
    expect((await verifyPolicyEnvelope(env, await getPolicySigningService()!.publicKeys())).ok).toBe(true);
    expect(signCalls).toBe(1);

    expect(await (await get()).json()).toEqual(env);
    expect(signCalls).toBe(1);
    expect((await get({ "if-none-match": `"${env.bundle.policyVersion}"` })).status).toBe(304);

    memoryInsertMemberPolicy(TENANT, memberId, { web: { block: ["games.example.com"] } });
    const changed = (await (await get()).json()) as PolicyEnvelope;
    expect(changed.bundle.web.block).toEqual(["games.example.com"]);
    expect(changed.bundle.policyVersion).not.toBe(env.bundle.policyVersion);
    expect(signCalls).toBe(2);
  });

  it("rejects a full-scope token and a browser session (device scope only), and an absent token", async () => {
    const minted = memoryCreateDesktopToken({ userId: OWNER.userId, tenantId: TENANT, role: "owner", name: "Omarchy bar" });
    if ("error" in minted) throw new Error(minted.error);
    authState.session = null;
    hdrs.current = new Headers({ authorization: `Bearer ${minted.token}` });
    const full = await policyGET(new Request("http://localhost/api/devices/policy"));
    expect(full.status).toBe(403);
    expect(await full.json()).toMatchObject({ code: "insufficient_scope" });
    hdrs.current = new Headers();
    expect((await policyGET(new Request("http://localhost/api/devices/policy"))).status).toBe(401);
    authState.session = { userId: OWNER.userId, tenantId: TENANT, role: "owner", user: { email: OWNER.email, name: OWNER.name }, expires: "2099-01-01T00:00:00Z" };
    expect((await policyGET(new Request("http://localhost/api/devices/policy"))).status).toBe(403);
    expect(signCalls).toBe(0);
  });

  it("answers 503 on a production deployment with no signer", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    setPolicySigningServiceForTests(undefined);
    const res = await get();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "policy_signing_unavailable" });
  });
});

describe("heartbeat on memory stores", () => {
  it("stores the applied version and returns the current one; older clients are unaffected", async () => {
    const env = (await (await get()).json()) as PolicyEnvelope;
    authState.session = null;
    hdrs.current = new Headers({ authorization: `Bearer ${token}` });
    const plain = await heartbeatPOST(post("/api/devices/heartbeat", { clientVersion: "1.0.0" }));
    expect(plain.status).toBe(200);
    const hb = (await plain.json()) as HeartbeatResponse;
    expect(hb.policyVersion).toBe(env.bundle.policyVersion);
    expect(Object.keys(hb)).toEqual(expect.arrayContaining(["device", "householdName", "memberName", "heartbeatSeconds", "listsVersion"]));
    const withVersion = await heartbeatPOST(post("/api/devices/heartbeat", { policyVersion: env.bundle.policyVersion }));
    expect(withVersion.status).toBe(200);
    expect((await getDevice(TENANT, deviceId))?.policyVersionApplied).toBe(env.bundle.policyVersion);
    expect((await heartbeatPOST(post("/api/devices/heartbeat", { policyVersion: "zz" }))).status).toBe(400);
  });
});
