// @vitest-environment node
/**
 * POST /api/devices/check-url (_specs/browser-extension.md "On-demand check"): scope and
 * 403s, the rating mapping on @neo/tools' MOCK_URLS fixtures, that nothing is saved or
 * alerted, and the hourly rate limit.
 */
import type { Session } from "next-auth";
import { MOCK_URLS } from "@neo/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as checkUrlPOST } from "@/app/api/devices/check-url/route";
import { POST as enrollPOST } from "@/app/api/devices/enroll/route";
import { POST as codesPOST } from "@/app/api/household/members/[userId]/enrollment-codes/route";
import { GET as verdictsGET } from "@/app/api/verdicts/route";
import { GET as alertsGET } from "@/app/api/alerts/route";
import type { CreateEnrollmentCodeResponse, EnrollDeviceResponse } from "@/lib/household-types";
import type { AlertListResponse } from "@/lib/alert-types";
import type { CheckUrlResponse } from "@/lib/signal-types";
import type { VerdictListResponse } from "@/lib/dashboard-types";
import { resetMemoryDevices } from "@/lib/server/memory-devices";
import { resetMemoryHousehold } from "@/lib/server/memory-household";
import { setMemoryMembers } from "@/lib/server/memory-state";
import { resetMemorySignals } from "@/lib/server/memory-signals";
import { resetRateLimits, takeDailySlot, takeRateSlot } from "@/lib/server/rate-limit";
import { post, resetMemoryState, stubBaseEnv } from "./helpers/routes";

const hdrs = vi.hoisted(() => ({ current: new Headers() }));
vi.mock("next/headers", () => ({
  headers: async () => hdrs.current,
  cookies: async () => ({ get: () => undefined, getAll: () => [] }),
}));
const authState = vi.hoisted(() => ({ session: null as Session | null }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => authState.session) }));

const TENANT = "00000000-0000-4000-8000-0000000000c1";
const OWNER = { userId: "user-owner", role: "owner" as const, email: "pat@example.test", name: "Pat" };
const GRAN = { userId: "user-gran", role: "member" as const, email: "gran@example.test", name: "Gran" };

function as(p: typeof OWNER | typeof GRAN): void {
  hdrs.current = new Headers();
  authState.session = { userId: p.userId, tenantId: TENANT, role: p.role, user: { email: p.email, name: p.name }, expires: "2099-01-01T00:00:00Z" };
}

function bearer(token: string): void {
  authState.session = null;
  hdrs.current = new Headers({ authorization: `Bearer ${token}` });
}

function params<T>(value: T): { params: Promise<T> } {
  return { params: Promise.resolve(value) };
}

async function createCode(userId: string): Promise<CreateEnrollmentCodeResponse> {
  const res = await codesPOST(post(`/api/household/members/${userId}/enrollment-codes`, {}), params({ userId }));
  expect(res.status).toBe(201);
  return (await res.json()) as CreateEnrollmentCodeResponse;
}

async function enrollDevice(userId: string): Promise<{ token: string; deviceId: string }> {
  const { code } = await createCode(userId);
  const res = await enrollPOST(
    new Request("http://localhost/api/devices/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.10" },
      body: JSON.stringify({ code, kind: "browser_extension", platform: "chrome", name: "Gran's Chrome", clientVersion: "1.0.0" }),
    }),
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as EnrollDeviceResponse;
  return { token: body.token, deviceId: body.device.id };
}

async function checkUrl(token: string, url: unknown): Promise<{ status: number; body: CheckUrlResponse | { error?: string; code?: string } }> {
  bearer(token);
  const res = await checkUrlPOST(post("/api/devices/check-url", { url }));
  return { status: res.status, body: (await res.json().catch(() => ({}))) as CheckUrlResponse };
}

beforeEach(() => {
  stubBaseEnv(vi);
  vi.stubEnv("DEV_AUTH_BYPASS", "false");
  resetMemoryState();
  resetMemoryHousehold();
  resetMemoryDevices();
  resetMemorySignals();
  resetRateLimits();
  setMemoryMembers(TENANT, [
    { userId: OWNER.userId, name: OWNER.name, email: OWNER.email, role: "owner" },
    { userId: GRAN.userId, name: GRAN.name, email: GRAN.email, role: "member" },
  ]);
  as(OWNER);
});
afterEach(() => vi.unstubAllEnvs());

describe("scope and auth", () => {
  it("a monitoring token (url:check) succeeds; a browser session gets 403 insufficient_scope", async () => {
    const { token } = await enrollDevice(GRAN.userId);
    const ok = await checkUrl(token, MOCK_URLS.clean);
    expect(ok.status).toBe(200);

    as(OWNER);
    const res = await checkUrlPOST(post("/api/devices/check-url", { url: MOCK_URLS.clean }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "insufficient_scope" });
  });

  it("a device-scoped token without url:check gets 403 insufficient_scope", async () => {
    // A signals-only monitoring token cannot check-url: scope is enforced before the device-id check.
    const { deviceId } = await enrollDevice(GRAN.userId);
    const { memoryInsertDeviceToken } = await import("@/lib/server/memory-desktop-tokens");
    const minted = memoryInsertDeviceToken({ userId: GRAN.userId, tenantId: TENANT, role: "member", name: "Signals only", deviceId, scopes: ["signals:write"] });
    bearer(minted.token);
    const res = await checkUrlPOST(post("/api/devices/check-url", { url: MOCK_URLS.clean }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "insufficient_scope" });
  });
});

describe("400 invalid", () => {
  it("rejects a missing, oversized, or non-http(s) url", async () => {
    const { token } = await enrollDevice(GRAN.userId);
    expect((await checkUrl(token, undefined)).status).toBe(400);
    expect((await checkUrl(token, "a".repeat(2049))).status).toBe(400);
    expect((await checkUrl(token, "javascript:alert(1)")).status).toBe(400);
    expect((await checkUrl(token, "ftp://example.com/file")).status).toBe(400);
  });
});

describe("rating mapping on MOCK_URLS", () => {
  it("clean → no_known_problems", async () => {
    const { token } = await enrollDevice(GRAN.userId);
    const { status, body } = await checkUrl(token, MOCK_URLS.clean);
    expect(status).toBe(200);
    expect(body).toMatchObject({ rating: "no_known_problems", domain: "example.com", reasons: [] });
    expect((body as CheckUrlResponse).checkedAt).toBeTruthy();
  });

  it("a Safe-Browsing-flagged phishing page → dangerous, with reasons", async () => {
    const { token } = await enrollDevice(GRAN.userId);
    const { status, body } = await checkUrl(token, MOCK_URLS.phish);
    expect(status).toBe(200);
    expect(body).toMatchObject({ rating: "dangerous", domain: "paypa1-secure-login.com" });
    expect((body as CheckUrlResponse).reasons.length).toBeGreaterThan(0);
  });

  it("a shortener redirecting to a flagged domain → dangerous", async () => {
    const { token } = await enrollDevice(GRAN.userId);
    const { status, body } = await checkUrl(token, MOCK_URLS.shortener);
    expect(status).toBe(200);
    expect(body).toMatchObject({ rating: "dangerous" });
  });
});

describe("not saved, not alerted, not counted against monthly checks", () => {
  it("leaves verdicts, alerts and usage untouched", async () => {
    const { token } = await enrollDevice(GRAN.userId);
    await checkUrl(token, MOCK_URLS.phish);

    as(OWNER);
    const alerts = (await (await alertsGET(new Request("http://localhost/api/alerts"))).json()) as AlertListResponse;
    expect(alerts.items).toEqual([]);

    const verdicts = (await (await verdictsGET(new Request("http://localhost/api/verdicts"))).json()) as VerdictListResponse;
    expect(verdicts.items).toEqual([]);
  });
});

describe("rate limits", () => {
  it("429 with Retry-After on the 31st request in an hour", async () => {
    const { token, deviceId } = await enrollDevice(GRAN.userId);
    for (let i = 0; i < 30; i++) takeRateSlot("device-check-url", deviceId, 30, 60 * 60 * 1000);
    const { status } = await checkUrl(token, MOCK_URLS.clean);
    expect(status).toBe(429);
  });

  it("429 on the 201st request in a UTC day", async () => {
    const { token, deviceId } = await enrollDevice(GRAN.userId);
    for (let i = 0; i < 200; i++) takeDailySlot("device-check-url-day", deviceId, 200);
    const { status } = await checkUrl(token, MOCK_URLS.clean);
    expect(status).toBe(429);
  });
});
