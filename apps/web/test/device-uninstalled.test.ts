// @vitest-environment node
/**
 * POST /api/devices/uninstalled (_specs/browser-extension.md "Uninstall"): a valid signature
 * revokes the device and raises device_removed once; a bad or missing signature is a silent
 * 204 no-op; the per-IP rate limit; and that the heartbeat response carries uninstallUrl.
 */
import type { Session } from "next-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as enrollPOST } from "@/app/api/devices/enroll/route";
import { POST as heartbeatPOST } from "@/app/api/devices/heartbeat/route";
import { POST as uninstalledPOST } from "@/app/api/devices/uninstalled/route";
import { POST as codesPOST } from "@/app/api/household/members/[userId]/enrollment-codes/route";
import type { CreateEnrollmentCodeResponse, EnrollDeviceResponse, HeartbeatResponse } from "@/lib/household-types";
import { memoryAlertRows, resetMemoryAlerts } from "@/lib/server/memory-alerts";
import { memoryGetDevice, resetMemoryDevices } from "@/lib/server/memory-devices";
import { resetMemoryHousehold } from "@/lib/server/memory-household";
import { setMemoryMembers } from "@/lib/server/memory-state";
import { resetMemorySignals } from "@/lib/server/memory-signals";
import { resetRateLimits, takeRateSlot } from "@/lib/server/rate-limit";
import { post, resetMemoryState, stubBaseEnv } from "./helpers/routes";

const hdrs = vi.hoisted(() => ({ current: new Headers() }));
vi.mock("next/headers", () => ({
  headers: async () => hdrs.current,
  cookies: async () => ({ get: () => undefined, getAll: () => [] }),
}));
const authState = vi.hoisted(() => ({ session: null as Session | null }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => authState.session) }));

const TENANT = "00000000-0000-4000-8000-0000000000d1";
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
      headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.11" },
      body: JSON.stringify({ code, kind: "browser_extension", platform: "chrome", name: "Gran's Chrome", clientVersion: "1.0.0" }),
    }),
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as EnrollDeviceResponse;
  return { token: body.token, deviceId: body.device.id };
}

async function heartbeat(token: string): Promise<HeartbeatResponse> {
  bearer(token);
  const res = await heartbeatPOST(post("/api/devices/heartbeat", {}));
  expect(res.status).toBe(200);
  return (await res.json()) as HeartbeatResponse;
}

function uninstallParams(url: string): { d: string; s: string } {
  const u = new URL(url);
  return { d: u.searchParams.get("d")!, s: u.searchParams.get("s")! };
}

async function reportUninstalled(body: unknown): Promise<Response> {
  return uninstalledPOST(post("/api/devices/uninstalled", body as Record<string, unknown>));
}

beforeEach(() => {
  stubBaseEnv(vi);
  vi.stubEnv("DEV_AUTH_BYPASS", "false");
  vi.stubEnv("AUTH_SECRET", "");
  resetMemoryState();
  resetMemoryAlerts();
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

describe("heartbeat carries uninstallUrl", () => {
  it("adds an uninstallUrl the device's own heartbeat produces", async () => {
    const { token, deviceId } = await enrollDevice(GRAN.userId);
    const body = await heartbeat(token);
    expect(body.uninstallUrl).toBeTruthy();
    const { d, s } = uninstallParams(body.uninstallUrl!);
    expect(d).toBe(deviceId);
    expect(s.length).toBeGreaterThan(0);
  });
});

describe("a valid signature", () => {
  it("revokes the device and raises device_removed exactly once, even if reported twice", async () => {
    const { token, deviceId } = await enrollDevice(GRAN.userId);
    const body = await heartbeat(token);
    const { d, s } = uninstallParams(body.uninstallUrl!);

    const first = await reportUninstalled({ d, s });
    expect(first.status).toBe(204);
    expect(memoryGetDevice(TENANT, deviceId)?.revokedAt).toBeInstanceOf(Date);
    const removedAlerts = memoryAlertRows().filter((a) => a.tenantId === TENANT && a.kind === "device_removed");
    expect(removedAlerts).toHaveLength(1);

    // Reported again (browser history, or a retry): idempotent, still 204, no second alert.
    const second = await reportUninstalled({ d, s });
    expect(second.status).toBe(204);
    expect(memoryAlertRows().filter((a) => a.tenantId === TENANT && a.kind === "device_removed")).toHaveLength(1);
  });
});

describe("bad or missing signatures change nothing", () => {
  it("a wrong signature: 204, device stays active", async () => {
    const { token, deviceId } = await enrollDevice(GRAN.userId);
    const body = await heartbeat(token);
    const { d } = uninstallParams(body.uninstallUrl!);

    const res = await reportUninstalled({ d, s: "not-the-real-signature" });
    expect(res.status).toBe(204);
    expect(memoryGetDevice(TENANT, deviceId)?.revokedAt).toBeNull();
    expect(memoryAlertRows().filter((a) => a.tenantId === TENANT && a.kind === "device_removed")).toEqual([]);
  });

  it("an unknown device id with any signature: 204, nothing to change", async () => {
    const res = await reportUninstalled({ d: "00000000-0000-4000-8000-000000000000", s: "whatever" });
    expect(res.status).toBe(204);
  });

  it("a malformed body: 400 bad_request", async () => {
    expect((await reportUninstalled({})).status).toBe(400);
    expect((await reportUninstalled({ d: "x" })).status).toBe(400);
    expect((await reportUninstalled({ d: "x", s: "" })).status).toBe(400);
    expect((await reportUninstalled(null)).status).toBe(400);
  });
});

describe("rate limit", () => {
  it("429 after 10 requests/hour/IP", async () => {
    const { token } = await enrollDevice(GRAN.userId);
    const body = await heartbeat(token);
    const { d, s } = uninstallParams(body.uninstallUrl!);
    for (let i = 0; i < 10; i++) takeRateSlot("device-uninstalled", "unknown", 10, 60 * 60 * 1000);
    const res = await reportUninstalled({ d, s });
    expect(res.status).toBe(429);
  });
});
