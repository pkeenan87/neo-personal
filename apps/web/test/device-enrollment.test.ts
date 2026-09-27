// @vitest-environment node
/**
 * Device enrollment on the in-memory stores (_specs/device-enrollment.md): owner code routes
 * and role guards, preview and enroll by code, the member email, heartbeat and self-unenroll
 * with a monitoring token, management by role, alerts by actor, leaving, and the offline sweep.
 */
import type { Session } from "next-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as approvePOST } from "@/app/api/desktop/device/approve/route";
import { POST as deviceStartPOST } from "@/app/api/desktop/device/route";
import { POST as deviceTokenPOST } from "@/app/api/desktop/device/token/route";
import { POST as enrollPOST } from "@/app/api/devices/enroll/route";
import { POST as previewPOST } from "@/app/api/devices/enroll/preview/route";
import { POST as heartbeatPOST } from "@/app/api/devices/heartbeat/route";
import { DELETE as selfDELETE } from "@/app/api/devices/self/route";
import { DELETE as codeDELETE } from "@/app/api/household/enrollment-codes/[id]/route";
import { DELETE as deviceDELETE, PATCH as devicePATCH } from "@/app/api/household/devices/[id]/route";
import { POST as leavePOST } from "@/app/api/household/leave/route";
import { POST as codesPOST } from "@/app/api/household/members/[userId]/enrollment-codes/route";
import { GET as householdGET } from "@/app/api/household/route";
import { GET as verdictsGET } from "@/app/api/verdicts/route";
import type { HouseholdResponse } from "@/lib/dashboard-types";
import type { DeviceAuthRedeemResponse, DeviceAuthStartResponse } from "@/lib/desktop-auth-types";
import type {
  CreateEnrollmentCodeResponse,
  EnrollDeviceResponse,
  EnrollmentPreviewResponse,
  HeartbeatResponse,
} from "@/lib/household-types";
import { alertDeviceOffline } from "@/lib/server/alerts";
import { memoryAuditLog } from "@/lib/server/audit";
import { DEVICE_ENROLL_LIMIT, HEARTBEAT_LIMIT, runOfflineDeviceSweep } from "@/lib/server/device-enrollment";
import { getDevice } from "@/lib/server/devices";
import { deviceLabel, deviceRemovedAlertText } from "@/lib/server/alerts/templates";
import { memorySentEmails } from "@/lib/server/email/resend";
import { memoryAlertRows, resetMemoryAlerts } from "@/lib/server/memory-alerts";
import { memoryCreateDesktopToken } from "@/lib/server/memory-desktop-tokens";
import { resetMemoryDesktopAuth } from "@/lib/server/memory-desktop-auth";
import { resetMemoryDevices } from "@/lib/server/memory-devices";
import { resetMemoryHousehold } from "@/lib/server/memory-household";
import { setMemoryMembers } from "@/lib/server/memory-state";
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
const KID = { userId: "user-kid", role: "member" as const, email: "kid@example.test", name: "Kid" };
const GRAN = { userId: "user-gran", role: "member" as const, email: "gran@example.test", name: "Gran" };
type Person = typeof OWNER | typeof KID;

const DEVICE = { kind: "browser_extension", platform: "chrome", name: "Chrome on Gran's laptop", clientVersion: "0.1.0" };
const HOUR = 60 * 60 * 1000;

function as(p: Person): void {
  hdrs.current = new Headers();
  authState.session = { userId: p.userId, tenantId: TENANT, role: p.role, user: { email: p.email, name: p.name }, expires: "2099-01-01T00:00:00Z" };
}

function bearer(token: string): void {
  authState.session = null;
  hdrs.current = new Headers({ authorization: `Bearer ${token}` });
}

/** A full-scope desktop token for the owner (the Omarchy bar). */
function fullToken(): string {
  const minted = memoryCreateDesktopToken({ userId: OWNER.userId, tenantId: TENANT, role: "owner", name: "Omarchy bar" });
  if ("error" in minted) throw new Error(minted.error);
  return minted.token;
}

function params<T>(value: T): { params: Promise<T> } {
  return { params: Promise.resolve(value) };
}

function fromIp(url: string, body: unknown, ip = "203.0.113.7"): Request {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

function createCode(userId: string): Promise<Response> {
  return codesPOST(post(`/api/household/members/${userId}/enrollment-codes`, {}), params({ userId }));
}

async function code(userId: string = GRAN.userId): Promise<CreateEnrollmentCodeResponse> {
  const res = await createCode(userId);
  expect(res.status).toBe(201);
  return (await res.json()) as CreateEnrollmentCodeResponse;
}

async function enroll(c: string, device: unknown = DEVICE): Promise<EnrollDeviceResponse> {
  const res = await enrollPOST(fromIp("/api/devices/enroll", { code: c, ...(device as object) }));
  expect(res.status).toBe(201);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return (await res.json()) as EnrollDeviceResponse;
}

async function householdAs(p: Person): Promise<HouseholdResponse> {
  as(p);
  return (await householdGET()).json() as Promise<HouseholdResponse>;
}

function removeDevice(id: string): Promise<Response> {
  return deviceDELETE(new Request(`http://localhost/api/household/devices/${id}`, { method: "DELETE" }), params({ id }));
}

function heartbeat(body: unknown = {}): Promise<Response> {
  return heartbeatPOST(post("/api/devices/heartbeat", body));
}

beforeEach(() => {
  stubBaseEnv(vi);
  vi.stubEnv("DEV_AUTH_BYPASS", "false");
  vi.stubEnv("INNGEST_EVENT_KEY", "");
  vi.stubEnv("AUTH_URL", "https://neo.example.test");
  resetMemoryState();
  resetMemoryAlerts();
  resetMemoryHousehold();
  resetMemoryDevices();
  resetMemoryDesktopAuth();
  resetRateLimits();
  memorySentEmails().length = 0;
  const g = globalThis as { __neoDesktopTokens?: unknown };
  g.__neoDesktopTokens = undefined;
  setMemoryMembers(TENANT, [
    { userId: OWNER.userId, name: OWNER.name, email: OWNER.email, role: "owner" },
    { userId: KID.userId, name: KID.name, email: KID.email, role: "member" },
    { userId: GRAN.userId, name: GRAN.name, email: GRAN.email, role: "member" },
  ]);
  as(OWNER);
});
afterEach(() => vi.unstubAllEnvs());

describe("enrollment codes (owner)", () => {
  it("creates a code shown once, lists it without the code, and cancels it idempotently", async () => {
    const res = await createCode(GRAN.userId);
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const created = (await res.json()) as CreateEnrollmentCodeResponse;
    expect(created.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(created.memberName).toBe("Gran");
    expect(new Date(created.expiresAt).getTime() - Date.now()).toBeGreaterThan(23 * HOUR);

    const home = await householdAs(OWNER);
    expect(home.enrollmentCodes).toEqual([expect.objectContaining({ id: created.id, userId: GRAN.userId, memberName: "Gran" })]);
    expect(JSON.stringify(home.enrollmentCodes)).not.toContain(created.code);
    expect(memoryAuditLog().map((e) => e.eventType)).toContain("device.enrollment_code_created");

    const del = () => codeDELETE(new Request(`http://localhost/api/household/enrollment-codes/${created.id}`, { method: "DELETE" }), params({ id: created.id }));
    expect((await del()).status).toBe(204);
    expect((await del()).status).toBe(204);
    expect((await householdAs(OWNER)).enrollmentCodes).toEqual([]);
    const unknown = crypto.randomUUID();
    expect((await codeDELETE(new Request(`http://localhost/api/household/enrollment-codes/${unknown}`, { method: "DELETE" }), params({ id: unknown }))).status).toBe(404);

    // A cancelled code does not preview or redeem.
    expect((await previewPOST(fromIp("/api/devices/enroll/preview", { code: created.code }))).status).toBe(404);
  });

  it("404s for someone outside the household and 409s at the pending-code cap", async () => {
    const outsider = await createCode("user-stranger");
    expect(outsider.status).toBe(404);
    for (let i = 0; i < 10; i++) await code(KID.userId);
    const capped = await createCode(KID.userId);
    expect(capped.status).toBe(409);
    expect(await capped.json()).toMatchObject({ code: "code_limit" });
  });

  it("is owner-only and browser-only", async () => {
    as(KID);
    const member = await createCode(KID.userId);
    expect(member.status).toBe(403);
    expect(await member.json()).toMatchObject({ code: "forbidden" });

    bearer(fullToken());
    const desktop = await createCode(GRAN.userId);
    expect(desktop.status).toBe(403);
    expect(await desktop.json()).toMatchObject({ code: "browser_session_required" });
  });
});

describe("enrollment by code (no session)", () => {
  it("previews, enrolls once, emails the member and returns a monitoring token", async () => {
    const created = await code();
    authState.session = null;

    const pv = await previewPOST(fromIp("/api/devices/enroll/preview", { code: created.code.toLowerCase().replaceAll("-", " ") }));
    expect(pv.status).toBe(200);
    expect((await pv.json()) as EnrollmentPreviewResponse).toMatchObject({ householdName: expect.any(String), memberName: "Gran", ownerName: "Pat" });

    const enrolled = await enroll(created.code.replaceAll("-", ""));
    expect(enrolled.token).toMatch(/^neo_dt_/);
    expect(enrolled.device).toMatchObject({ userId: GRAN.userId, name: DEVICE.name, enrollment: "code", enrolledByName: "Pat", status: "never_seen" });
    expect(enrolled.memberName).toBe("Gran");

    // Single use.
    const again = await enrollPOST(fromIp("/api/devices/enroll", { code: created.code, ...DEVICE }));
    expect(again.status).toBe(404);

    const mail = memorySentEmails();
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({ to: GRAN.email, subject: "A device is now protected by Neo", idempotencyKey: `device-enrolled:${enrolled.device.id}` });
    expect(mail[0]!.text).toContain("Pat added");
    expect(mail[0]!.text).toContain(DEVICE.name);
    expect(mail[0]!.text).toContain("never reports: your browsing history, the pages you visit, your files");
    expect(mail[0]!.text).toContain("http://localhost/settings/household");

    // Code enrollment by the owner never alerts.
    expect(memoryAlertRows()).toHaveLength(0);

    // The monitoring token cannot read the household's checks.
    bearer(enrolled.token);
    const verdicts = await verdictsGET(new Request("http://localhost/api/verdicts"));
    expect(verdicts.status).toBe(403);
    expect(await verdicts.json()).toMatchObject({ code: "insufficient_scope" });
  });

  it("does not email the owner about their own device", async () => {
    const created = await code(OWNER.userId);
    await enroll(created.code);
    expect(memorySentEmails()).toHaveLength(0);
  });

  it("rejects bad input with 400 and unknown codes with 404", async () => {
    const created = await code();
    expect((await enrollPOST(fromIp("/api/devices/enroll", { code: created.code, ...DEVICE, kind: "toaster" }))).status).toBe(400);
    expect((await enrollPOST(fromIp("/api/devices/enroll", { code: created.code, ...DEVICE, name: "" }))).status).toBe(400);
    expect((await enrollPOST(fromIp("/api/devices/enroll", { ...DEVICE }))).status).toBe(400);
    expect((await enrollPOST(fromIp("/api/devices/enroll", { code: "BBBB-CCCC-DDDD", ...DEVICE }))).status).toBe(404);
    expect((await previewPOST(fromIp("/api/devices/enroll/preview", {}))).status).toBe(400);
  });

  it("shares 10 attempts per hour per IP between preview and enroll", async () => {
    for (let i = 0; i < DEVICE_ENROLL_LIMIT.limit / 2; i++) {
      expect((await previewPOST(fromIp("/api/devices/enroll/preview", { code: "BBBB-CCCC-DDDD" }))).status).toBe(404);
      expect((await enrollPOST(fromIp("/api/devices/enroll", { code: "BBBB-CCCC-DDDD", ...DEVICE }))).status).toBe(404);
    }
    const limited = await previewPOST(fromIp("/api/devices/enroll/preview", { code: "BBBB-CCCC-DDDD" }));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    // Another IP is unaffected.
    expect((await previewPOST(fromIp("/api/devices/enroll/preview", { code: "BBBB-CCCC-DDDD" }, "198.51.100.1"))).status).toBe(404);
  });
});

describe("device self-service (scope device)", () => {
  it("heartbeats with the monitoring token, not with a browser session", async () => {
    const enrolled = await enroll((await code()).code);

    as(OWNER);
    const browser = await heartbeat();
    expect(browser.status).toBe(403);
    expect(await browser.json()).toMatchObject({ code: "insufficient_scope" });

    bearer(enrolled.token);
    const res = await heartbeat({ clientVersion: "0.2.0" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as HeartbeatResponse;
    expect(body).toMatchObject({ memberName: "Gran", heartbeatSeconds: 3600, device: { id: enrolled.device.id, status: "active", clientVersion: "0.2.0" } });
    expect((await heartbeat({ clientVersion: 42 })).status).toBe(400);
    for (let i = 2; i < HEARTBEAT_LIMIT.limit; i++) expect((await heartbeat()).status).toBe(200);
    expect((await heartbeat()).status).toBe(429);
  });

  it("self-unenroll revokes the device and its token and raises a high alert", async () => {
    const enrolled = await enroll((await code()).code);
    bearer(enrolled.token);
    expect((await selfDELETE()).status).toBe(204);
    expect((await getDevice(TENANT, enrolled.device.id))?.revokedAt).toBeInstanceOf(Date);
    expect((await heartbeat()).status).toBe(401);

    const [alert] = memoryAlertRows();
    expect(alert).toMatchObject({
      kind: "device_removed",
      severity: "high",
      deviceId: enrolled.device.id,
      subjectUserId: GRAN.userId,
      title: `${DEVICE.name} was uninstalled`,
      dedupeKey: `device_removed:${enrolled.device.id}`,
    });
    expect(memoryAuditLog().find((e) => e.eventType === "device.revoked")?.metadata).toEqual({ deviceId: enrolled.device.id, by: "device" });
    // The high alert emails the owner, linking to household settings.
    const ownerMail = memorySentEmails().find((m) => m.to === OWNER.email);
    expect(ownerMail?.text).toContain("https://neo.example.test/settings/household");
  });

  it("an owner's own device never alerts on removal", async () => {
    const enrolled = await enroll((await code(OWNER.userId)).code);
    bearer(enrolled.token);
    expect((await selfDELETE()).status).toBe(204);
    expect(memoryAlertRows()).toHaveLength(0);
  });
});

describe("device management (browser session)", () => {
  it("owner renames and removes without an alert", async () => {
    const { device } = await enroll((await code()).code);
    as(OWNER);
    const renamed = await devicePATCH(
      new Request(`http://localhost/api/household/devices/${device.id}`, { method: "PATCH", body: JSON.stringify({ name: "  Gran's Chrome " }) }),
      params({ id: device.id }),
    );
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ device: { id: device.id, name: "Gran's Chrome" } });
    const bad = await devicePATCH(
      new Request(`http://localhost/api/household/devices/${device.id}`, { method: "PATCH", body: JSON.stringify({ name: "" }) }),
      params({ id: device.id }),
    );
    expect(bad.status).toBe(400);

    expect((await removeDevice(device.id)).status).toBe(204);
    expect((await removeDevice(device.id)).status).toBe(404);
    expect(memoryAlertRows()).toHaveLength(0);
    expect((await householdAs(OWNER)).devices).toEqual([]);
  });

  it("members see and remove only their own devices; their removal alerts the owner", async () => {
    const grans = await enroll((await code(GRAN.userId)).code);
    as(OWNER);
    const kids = await enroll((await code(KID.userId)).code);

    expect((await householdAs(OWNER)).devices.map((d) => d.id).sort()).toEqual([grans.device.id, kids.device.id].sort());
    const kidView = await householdAs(KID);
    expect(kidView.devices.map((d) => d.id)).toEqual([kids.device.id]);
    expect(kidView.enrollmentCodes).toEqual([]);

    as(KID);
    const renamed = await devicePATCH(
      new Request(`http://localhost/api/household/devices/${kids.device.id}`, { method: "PATCH", body: JSON.stringify({ name: "Mine" }) }),
      params({ id: kids.device.id }),
    );
    expect(renamed.status).toBe(403);
    const other = await removeDevice(grans.device.id);
    expect(other.status).toBe(403);
    expect(await other.json()).toMatchObject({ code: "forbidden" });

    expect((await removeDevice(kids.device.id)).status).toBe(204);
    const [alert] = memoryAlertRows();
    expect(alert).toMatchObject({ kind: "device_removed", severity: "high", deviceId: kids.device.id, title: `Kid removed ${DEVICE.name}` });

    // Its token is dead.
    bearer(kids.token);
    expect((await heartbeat()).status).toBe(401);
  });

  it("a desktop token cannot manage devices", async () => {
    const { device } = await enroll((await code()).code);
    bearer(fullToken());
    const res = await removeDevice(device.id);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "browser_session_required" });
  });

  it("leaving the household revokes the member's devices", async () => {
    const kids = await enroll((await code(KID.userId)).code);
    as(KID);
    expect((await leavePOST()).status).toBe(204);
    bearer(kids.token);
    expect((await heartbeat()).status).toBe(401);
    expect((await householdAs(OWNER)).devices).toEqual([]);
  });
});

describe("self-enrollment through the device flow", () => {
  async function selfEnroll(p: Person): Promise<DeviceAuthRedeemResponse> {
    authState.session = null;
    hdrs.current = new Headers();
    const start = await deviceStartPOST(post("/api/desktop/device", { clientName: "Neo extension", device: DEVICE }));
    const started = (await start.json()) as DeviceAuthStartResponse;
    as(p);
    expect((await approvePOST(post("/api/desktop/device/approve", { userCode: started.userCode, approve: true }))).status).toBe(200);
    const redeemed = await deviceTokenPOST(post("/api/desktop/device/token", { deviceCode: started.deviceCode }));
    expect(redeemed.status).toBe(200);
    return (await redeemed.json()) as DeviceAuthRedeemResponse;
  }

  it("raises a low alert for a member", async () => {
    const r = await selfEnroll(KID);
    expect(r.device).toMatchObject({ enrollment: "self", userId: KID.userId });
    const [alert] = memoryAlertRows();
    expect(alert).toMatchObject({ kind: "device_enrolled", severity: "low", deviceId: r.device!.id, title: `Kid added ${DEVICE.name}` });
    // Self-enrollment does not email the member.
    expect(memorySentEmails().filter((m) => m.to === KID.email)).toHaveLength(0);
  });

  it("raises nothing for an owner", async () => {
    await selfEnroll(OWNER);
    expect(memoryAlertRows()).toHaveLength(0);
  });
});

describe("offline sweep", () => {
  it("raises one medium alert per outage and a heartbeat re-arms it", async () => {
    const { device, token } = await enroll((await code()).code);
    const created = new Date(device.createdAt).getTime();

    expect(await runOfflineDeviceSweep(undefined, new Date(created + 47 * HOUR))).toMatchObject({ alerted: 0 });
    expect(await runOfflineDeviceSweep(undefined, new Date(created + 49 * HOUR))).toMatchObject({ stale: 1, alerted: 1 });
    expect(await runOfflineDeviceSweep(undefined, new Date(created + 50 * HOUR))).toMatchObject({ stale: 0, alerted: 0 });
    const first = memoryAlertRows();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      kind: "device_offline",
      severity: "medium",
      deviceId: device.id,
      title: `${DEVICE.name} (Gran) has not checked in for 2 days`,
      dedupeKey: `device_offline:${device.id}:${created}`,
    });

    // The heartbeat clears the offline mark; the next outage alerts again.
    bearer(token);
    expect((await heartbeat()).status).toBe(200);
    const seen = (await getDevice(TENANT, device.id))!.lastSeenAt!.getTime();
    expect(await runOfflineDeviceSweep(undefined, new Date(seen + 49 * HOUR))).toMatchObject({ alerted: 1 });
    expect(memoryAlertRows()).toHaveLength(2);
    expect(memoryAlertRows()[1]!.dedupeKey).toBe(`device_offline:${device.id}:${seen}`);
  });

  it("never alerts for a device protecting an owner", async () => {
    const { device } = await enroll((await code(OWNER.userId)).code);
    const r = await runOfflineDeviceSweep(undefined, new Date(new Date(device.createdAt).getTime() + 49 * HOUR));
    expect(r).toMatchObject({ stale: 1, marked: 1, alerted: 0 });
    expect(memoryAlertRows()).toHaveLength(0);
  });

  it("keeps going when one device fails", async () => {
    const d = (await getDevice(TENANT, (await enroll((await code()).code)).device.id))!;
    const r = await runOfflineDeviceSweep({
      listStale: async () => [
        { id: "x", tenantId: TENANT },
        { id: d.id, tenantId: TENANT },
      ],
      markOffline: async (_t, id) => {
        if (id === "x") throw new Error("boom");
        return d;
      },
      alertOffline: alertDeviceOffline,
    });
    expect(r).toEqual({ stale: 2, marked: 1, alerted: 1, errors: 1 });
  });
});

describe("device alert text", () => {
  it("cleans and truncates client-supplied device names", () => {
    const label = deviceLabel(`Chrome\u0007\n${"x".repeat(100)}`);
    expect(label).not.toMatch(/[\u0000-\u001f]/);
    expect([...label].length).toBeLessThanOrEqual(64);
    expect(deviceLabel("   ")).toBe("A device");
    expect(deviceRemovedAlertText("Kid", label, "device").title).toBe(`${label} was uninstalled`);
  });
});
