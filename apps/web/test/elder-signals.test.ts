// @vitest-environment node
/**
 * Elder protection mode through the signal pipeline on the in-memory stores (_specs/v2-m1-elder.md
 * §4): an unknown-peer session is critical, an install after it raises install_during_session,
 * an extension uninstall raises protection_disabled, and Standard members see none of it.
 */
import type { Session } from "next-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as enrollPOST } from "@/app/api/devices/enroll/route";
import { POST as heartbeatPOST } from "@/app/api/devices/heartbeat/route";
import { POST as uninstalledPOST } from "@/app/api/devices/uninstalled/route";
import { POST as codesPOST } from "@/app/api/household/members/[userId]/enrollment-codes/route";
import { POST as signalsPOST } from "@/app/api/signals/route";
import type { CreateEnrollmentCodeResponse, EnrollDeviceResponse, HeartbeatResponse } from "@/lib/household-types";
import type { SignalIngestResponse } from "@/lib/signal-types";
import { memoryAlertRows, resetMemoryAlerts } from "@/lib/server/memory-alerts";
import { resetMemoryDevices } from "@/lib/server/memory-devices";
import { resetMemoryHousehold } from "@/lib/server/memory-household";
import { resetMemoryProtection, setMemoryMemberMode } from "@/lib/server/memory-members";
import { setMemoryMembers } from "@/lib/server/memory-state";
import { resetMemorySignals } from "@/lib/server/memory-signals";
import { resetRateLimits } from "@/lib/server/rate-limit";
import { runOfflineDeviceSweep } from "@/lib/server/device-enrollment";
import { setExpectedTools } from "@/lib/server/signals/store";
import { post, resetMemoryState, stubBaseEnv } from "./helpers/routes";

const hdrs = vi.hoisted(() => ({ current: new Headers() }));
vi.mock("next/headers", () => ({
  headers: async () => hdrs.current,
  cookies: async () => ({ get: () => undefined, getAll: () => [] }),
}));
const authState = vi.hoisted(() => ({ session: null as Session | null }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => authState.session) }));

const TENANT = "00000000-0000-4000-8000-0000000000e1";
const OWNER = { userId: "user-owner", role: "owner" as const, email: "pat@example.test", name: "Pat" };
const GRAN = { userId: "user-gran", role: "member" as const, email: "gran@example.test", name: "Gran" };
const PAL = { userId: "user-pal", role: "member" as const, email: "pal@example.test", name: "Pal" };

function as(p: { userId: string; role: "owner" | "member"; email: string; name: string }): void {
  hdrs.current = new Headers();
  authState.session = { userId: p.userId, tenantId: TENANT, role: p.role, user: { email: p.email, name: p.name }, expires: "2099-01-01T00:00:00Z" };
}

function bearer(token: string): void {
  authState.session = null;
  hdrs.current = new Headers({ authorization: `Bearer ${token}` });
}

async function enrollDevice(userId: string): Promise<{ token: string; deviceId: string }> {
  as(OWNER);
  const codeRes = await codesPOST(post(`/api/household/members/${userId}/enrollment-codes`, {}), { params: Promise.resolve({ userId }) });
  const { code } = (await codeRes.json()) as CreateEnrollmentCodeResponse;
  const res = await enrollPOST(
    new Request("http://localhost/api/devices/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.21" },
      body: JSON.stringify({ code, kind: "browser_extension", platform: "chrome", name: "Chrome", clientVersion: "1.0.0" }),
    }),
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as EnrollDeviceResponse;
  return { token: body.token, deviceId: body.device.id };
}

async function send(token: string, events: unknown[]): Promise<SignalIngestResponse> {
  bearer(token);
  const res = await signalsPOST(post("/api/signals", { events }));
  expect(res.status).toBe(200);
  return (await res.json()) as SignalIngestResponse;
}

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
const session = (peerId: string, offsetMs = -60_000) => ({ id: crypto.randomUUID(), type: "remote_session", detector: "remote_access_session", observedAt: iso(offsetMs), toolId: "anydesk", direction: "incoming", peerId });
const install = () => ({ id: crypto.randomUUID(), type: "software", detector: "unwanted_software", observedAt: iso(), name: "Scam Cleaner", reason: "publisher_list" });
const kindsOf = () => memoryAlertRows().filter((a) => a.tenantId === TENANT).map((a) => a.kind);

async function setHelper(deviceId: string): Promise<void> {
  await setExpectedTools({ tenantId: TENANT, deviceId, tools: [{ toolId: "anydesk", peerIds: ["grandson"] }], createdBy: OWNER.userId });
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
  resetMemorySignals();
  resetMemoryProtection();
  resetRateLimits();
  setMemoryMembers(TENANT, [
    { userId: OWNER.userId, name: OWNER.name, email: OWNER.email, role: "owner" },
    { userId: GRAN.userId, name: GRAN.name, email: GRAN.email, role: "member" },
    { userId: PAL.userId, name: PAL.name, email: PAL.email, role: "member" },
  ]);
});
afterEach(() => vi.unstubAllEnvs());

describe("Elder member", () => {
  beforeEach(() => setMemoryMemberMode(TENANT, GRAN.userId, "elder"));

  it("an unknown peer on an expected tool is critical (Standard: high), and an install soon after raises install_during_session", async () => {
    const { token, deviceId } = await enrollDevice(GRAN.userId);
    await setHelper(deviceId);

    const first = await send(token, [session("stranger")]);
    expect(first.results[0]).toMatchObject({ status: "accepted", severity: "critical" });

    await send(token, [install()]);
    const alerts = memoryAlertRows().filter((a) => a.tenantId === TENANT && a.kind === "install_during_session");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: "critical", subjectUserId: GRAN.userId });
    expect(alerts[0]!.title).toMatch(/^Stop and hang up/);
    expect(alerts[0]!.signalIds).toHaveLength(2);

    // Same bucket: a second install does not raise a second alert.
    await send(token, [install()]);
    expect(kindsOf().filter((k) => k === "install_during_session")).toHaveLength(1);
  });

  it("a helper's own (expected-peer) session followed by an install does not page", async () => {
    const { token, deviceId } = await enrollDevice(GRAN.userId);
    await setHelper(deviceId);
    expect((await send(token, [session("grandson")])).results[0]).toMatchObject({ severity: "low" });
    await send(token, [install()]);
    expect(kindsOf()).not.toContain("install_during_session");
  });

  it("raises protection_disabled when the extension uninstall beacon arrives, once per hour", async () => {
    const { token, deviceId } = await enrollDevice(GRAN.userId);
    bearer(token);
    const hb = (await (await heartbeatPOST(post("/api/devices/heartbeat", {}))).json()) as HeartbeatResponse;
    const u = new URL(hb.uninstallUrl!);
    const res = await uninstalledPOST(post("/api/devices/uninstalled", { d: u.searchParams.get("d"), s: u.searchParams.get("s") }));
    expect(res.status).toBe(204);
    const rows = memoryAlertRows().filter((a) => a.kind === "protection_disabled");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ deviceId, subjectUserId: GRAN.userId, severity: "high" });
    expect(rows[0]!.dedupeKey).toMatch(new RegExp(`^protection_disabled:${deviceId}:`));
    expect(kindsOf()).toContain("device_removed"); // today's alert is kept
  });

  it("raises protection_disabled from the offline sweep alongside device_offline", async () => {
    const { deviceId } = await enrollDevice(GRAN.userId);
    const device = { id: deviceId, tenantId: TENANT, userId: GRAN.userId, name: "Chrome", lastSeenAt: null, createdAt: new Date() } as never;
    const result = await runOfflineDeviceSweep({
      listStale: async () => [{ id: deviceId, tenantId: TENANT }],
      markOffline: async () => device,
      alertOffline: async () => true,
      protectionDisabled: async (d) => (await import("@/lib/server/signals/server-signals")).recordServerSignal(d, "device_offline"),
    });
    expect(result.alerted).toBe(1);
    expect(kindsOf()).toContain("protection_disabled");
  });
});

describe("Standard member (unchanged)", () => {
  it("unknown peer is high, an install after it adds no correlated alert, and an uninstall raises no protection_disabled", async () => {
    const { token, deviceId } = await enrollDevice(PAL.userId);
    await setHelper(deviceId);
    expect((await send(token, [session("stranger")])).results[0]).toMatchObject({ severity: "high" });
    await send(token, [install()]);
    expect(kindsOf()).not.toContain("install_during_session");

    bearer(token);
    const hb = (await (await heartbeatPOST(post("/api/devices/heartbeat", {}))).json()) as HeartbeatResponse;
    const u = new URL(hb.uninstallUrl!);
    await uninstalledPOST(post("/api/devices/uninstalled", { d: u.searchParams.get("d"), s: u.searchParams.get("s") }));
    expect(kindsOf()).toContain("device_removed");
    expect(kindsOf()).not.toContain("protection_disabled");
  });
});
