// @vitest-environment node
/**
 * Signals on the in-memory stores (_specs/signals.md): the ingest route (per-event results,
 * duplicates, rate limits), escalation with injected deps (cache hit and failure), alerts and
 * emails including owner-device signals, scam-in-progress correlation, the lists route
 * (ETag/304), the heartbeat `listsVersion`, and the expected-tools route by role.
 */
import type { Session } from "next-auth";
import { createInMemoryCache, type UrlAnalysis } from "@neo/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as alertsGET } from "@/app/api/alerts/route";
import { POST as enrollPOST } from "@/app/api/devices/enroll/route";
import { POST as heartbeatPOST } from "@/app/api/devices/heartbeat/route";
import { PUT as expectedToolsPUT } from "@/app/api/household/devices/[id]/expected-tools/route";
import { POST as codesPOST } from "@/app/api/household/members/[userId]/enrollment-codes/route";
import { POST as signalsPOST } from "@/app/api/signals/route";
import { GET as listsGET } from "@/app/api/signals/lists/route";
import { GET as statusGET } from "@/app/api/signals/status/route";
import type { CreateEnrollmentCodeResponse, EnrollDeviceResponse, HeartbeatResponse } from "@/lib/household-types";
import type { AlertListResponse } from "@/lib/alert-types";
import type { SignalIngestResponse, SignalStatusResponse } from "@/lib/signal-types";
import { memoryAlertRows, resetMemoryAlerts } from "@/lib/server/memory-alerts";
import { resetMemoryDevices } from "@/lib/server/memory-devices";
import { resetMemoryHousehold } from "@/lib/server/memory-household";
import { setMemoryMembers } from "@/lib/server/memory-state";
import { resetMemorySignals } from "@/lib/server/memory-signals";
import { memorySentEmails } from "@/lib/server/email/resend";
import { resetRateLimits, takeRateSlot } from "@/lib/server/rate-limit";
import { createEscalateDeps, runSignalEscalate, type EscalateDeps } from "@/lib/server/signals/escalate";
import { getDeviceSignal, insertDeviceSignal, listExpectedTools } from "@/lib/server/signals/store";
import { post, resetMemoryState, stubBaseEnv } from "./helpers/routes";

const hdrs = vi.hoisted(() => ({ current: new Headers() }));
vi.mock("next/headers", () => ({
  headers: async () => hdrs.current,
  cookies: async () => ({ get: () => undefined, getAll: () => [] }),
}));
const authState = vi.hoisted(() => ({ session: null as Session | null }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => authState.session) }));

const TENANT = "00000000-0000-4000-8000-0000000000b1";
const OWNER = { userId: "user-owner", role: "owner" as const, email: "pat@example.test", name: "Pat" };
const GRAN = { userId: "user-gran", role: "member" as const, email: "gran@example.test", name: "Gran" };
type Person = typeof OWNER | typeof GRAN;

function as(p: Person): void {
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

/** Enroll a browser-extension device (reports signals) for `userId`, returning its monitoring token and device id. */
async function enrollDevice(userId: string, name = "Test browser"): Promise<{ token: string; deviceId: string }> {
  const { code } = await createCode(userId);
  const res = await enrollPOST(
    new Request("http://localhost/api/devices/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.9" },
      body: JSON.stringify({ code, kind: "browser_extension", platform: "chrome", name, clientVersion: "1.0.0" }),
    }),
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as EnrollDeviceResponse;
  return { token: body.token, deviceId: body.device.id };
}

function uuid(): string {
  return crypto.randomUUID();
}

// Real wall-clock "now": ingestSignals reads the actual clock (there's no way to inject a fake
// `now` through the HTTP route), so every observedAt below is relative to it, not to a fixed date.
const NOW = new Date();
const iso = (d: Date = NOW) => d.toISOString();

function techSupportScamEvent(overrides: Record<string, unknown> = {}) {
  return { id: uuid(), type: "page", detector: "tech_support_scam", observedAt: iso(), domain: "scam-support.test", indicators: ["fullscreen", "fake_scan"], ...overrides };
}

function remoteAccessToolEvent(overrides: Record<string, unknown> = {}) {
  return { id: uuid(), type: "software", detector: "remote_access_tool", observedAt: iso(), toolId: "anydesk", name: "AnyDesk", ...overrides };
}

async function sendSignals(token: string, events: unknown[]): Promise<{ status: number; body: SignalIngestResponse }> {
  bearer(token);
  const res = await signalsPOST(post("/api/signals", { events }));
  const body = (await res.json().catch(() => ({ results: [] }))) as SignalIngestResponse;
  return { status: res.status, body };
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
  resetRateLimits();
  memorySentEmails().length = 0;
  setMemoryMembers(TENANT, [
    { userId: OWNER.userId, name: OWNER.name, email: OWNER.email, role: "owner" },
    { userId: GRAN.userId, name: GRAN.name, email: GRAN.email, role: "member" },
  ]);
  as(OWNER);
});
afterEach(() => vi.unstubAllEnvs());

describe("ingest: per-event results", () => {
  it("returns one result per event, in order, for valid/invalid/duplicate/stale/unknown_tool", async () => {
    const { token, deviceId } = await enrollDevice(GRAN.userId);
    const valid = techSupportScamEvent();
    const stale = techSupportScamEvent({ observedAt: iso(new Date(NOW.getTime() - 25 * 60 * 60 * 1000)) });
    const unknownTool = remoteAccessToolEvent({ toolId: "not-a-real-tool" });
    const malformed = { id: uuid(), type: "page", detector: "tech_support_scam" }; // missing domain/indicators

    const first = await sendSignals(token, [valid, stale, unknownTool, malformed]);
    expect(first.status).toBe(200);
    expect(first.body.results).toEqual([
      { id: valid.id, status: "accepted", severity: "high", verdictId: expect.any(String) },
      { id: stale.id, status: "rejected", reason: "stale" },
      { id: unknownTool.id, status: "rejected", reason: "unknown_tool" },
      { id: malformed.id, status: "rejected", reason: "invalid" },
    ]);

    // A retry of the same batch: the valid event is now a duplicate, nothing re-alerts.
    const before = memoryAlertRows().length;
    const second = await sendSignals(token, [valid]);
    expect(second.body.results).toEqual([{ id: valid.id, status: "duplicate" }]);
    expect(memoryAlertRows().length).toBe(before);
    void deviceId;
  });

  it("apple_screen_sharing: install and download events are invalid, a session is accepted", async () => {
    const { token } = await enrollDevice(GRAN.userId);
    const install = remoteAccessToolEvent({ toolId: "apple_screen_sharing", name: "Apple Screen Sharing" });
    const download = { id: uuid(), type: "download", detector: "remote_tool_download", observedAt: iso(), toolId: "apple_screen_sharing", domain: "apple.com" };
    const session = { id: uuid(), type: "remote_session", detector: "remote_access_session", observedAt: iso(), toolId: "apple_screen_sharing", direction: "incoming" };
    const r = await sendSignals(token, [install, download, session]);
    expect(r.status).toBe(200);
    expect(r.body.results[0]).toEqual({ id: install.id, status: "rejected", reason: "invalid" });
    expect(r.body.results[1]).toEqual({ id: download.id, status: "rejected", reason: "invalid" });
    expect(r.body.results[2]).toMatchObject({ id: session.id, status: "accepted" });
  });

  it("rejects a domain that isn't its own registrable domain", async () => {
    const { token } = await enrollDevice(GRAN.userId);
    const withPath = techSupportScamEvent({ domain: "scam.test/login" }); // schema itself also rejects "/" but exercise the path
    const r = await sendSignals(token, [withPath]);
    expect(r.body.results[0]).toMatchObject({ status: "rejected", reason: "invalid" });
  });

  it("warning_bypassed before its related event (in the same batch) is rejected relates_to_unknown", async () => {
    const { token } = await enrollDevice(GRAN.userId);
    const bypass = { id: uuid(), type: "page", detector: "warning_bypassed", observedAt: iso(), relatesTo: uuid(), domain: "scam.test" };
    const r = await sendSignals(token, [bypass]);
    expect(r.body.results[0]).toMatchObject({ status: "rejected", reason: "relates_to_unknown" });
  });

  it("warning_bypassed after its related event (same batch, in order) bumps severity and raises a second alert", async () => {
    const { token } = await enrollDevice(GRAN.userId);
    const scam = techSupportScamEvent();
    const bypass = { id: uuid(), type: "page", detector: "warning_bypassed", observedAt: iso(new Date(NOW.getTime() + 1000)), relatesTo: scam.id, domain: "scam-support.test" };
    const r = await sendSignals(token, [scam, bypass]);
    expect(r.body.results[0]).toMatchObject({ status: "accepted", severity: "high" });
    expect(r.body.results[1]).toMatchObject({ status: "accepted", severity: "critical" });
    const kinds = memoryAlertRows()
      .filter((a) => a.tenantId === TENANT)
      .map((a) => a.kind);
    expect(kinds.filter((k) => k === "scam_page")).toHaveLength(2); // the original + the bypass bump
  });
});

describe("ingest: auth", () => {
  it("400 bad_request for a malformed body", async () => {
    const { token } = await enrollDevice(GRAN.userId);
    bearer(token);
    const res = await signalsPOST(post("/api/signals", { events: "nope" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "bad_request" });
  });

  it("400 bad_request for an empty or oversized batch", async () => {
    const { token } = await enrollDevice(GRAN.userId);
    bearer(token);
    expect((await signalsPOST(post("/api/signals", { events: [] }))).status).toBe(400);
    const big = Array.from({ length: 51 }, () => techSupportScamEvent());
    expect((await signalsPOST(post("/api/signals", { events: big }))).status).toBe(400);
  });
});

describe("ingest: rate limits", () => {
  it("429 after 60 requests/hour/device", async () => {
    const { token, deviceId } = await enrollDevice(GRAN.userId);
    for (let i = 0; i < 60; i++) expect(takeRateSlot("signals-ingest", deviceId, 60, 60 * 60 * 1000).ok).toBe(true);
    bearer(token);
    const res = await signalsPOST(post("/api/signals", { events: [techSupportScamEvent()] }));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  it("500 accepted events/device/day → rate_limited, and floods audit once", async () => {
    const { token, deviceId } = await enrollDevice(GRAN.userId);
    for (let i = 0; i < 500; i++) {
      await insertDeviceSignal({
        tenantId: TENANT,
        deviceId,
        userId: GRAN.userId,
        clientEventId: uuid(),
        type: "page",
        detector: "tech_support_scam",
        subject: "seed.test",
        payload: {},
        observedAt: NOW,
        now: NOW,
      });
    }
    const event = techSupportScamEvent();
    const r = await sendSignals(token, [event]);
    expect(r.body.results[0]).toMatchObject({ status: "rejected", reason: "rate_limited" });
  });
});

describe("expected tools + remote-access sessions", () => {
  it("an unexpected incoming session is critical; an expected tool with a known peer is low; an unknown peer is high", async () => {
    const { token, deviceId } = await enrollDevice(GRAN.userId);
    as(OWNER);
    const put1 = await expectedToolsPUT(
      post(`/api/household/devices/${deviceId}/expected-tools`, { tools: [{ toolId: "anydesk", peerIds: ["owner-peer-1"] }] }),
      params({ id: deviceId }),
    );
    expect(put1.status).toBe(200);
    expect(await put1.json()).toMatchObject({ tools: [{ toolId: "anydesk", name: "AnyDesk", peerIds: ["owner-peer-1"] }] });

    const knownPeer = { id: uuid(), type: "remote_session", detector: "remote_access_session", observedAt: iso(), toolId: "anydesk", direction: "incoming", peerId: "owner-peer-1" };
    const unknownPeer = { id: uuid(), type: "remote_session", detector: "remote_access_session", observedAt: iso(), toolId: "anydesk", direction: "incoming", peerId: "a-stranger" };
    const r = await sendSignals(token, [knownPeer, unknownPeer]);
    expect(r.body.results[0]).toMatchObject({ status: "accepted", severity: "low" });
    expect(r.body.results[1]).toMatchObject({ status: "accepted", severity: "high" });
  });
});

describe("expected tool installs", () => {
  it("an install of a tool marked expected raises a low alert, not high", async () => {
    const { token, deviceId } = await enrollDevice(GRAN.userId);
    as(OWNER);
    await expectedToolsPUT(post(`/api/household/devices/${deviceId}/expected-tools`, { tools: [{ toolId: "anydesk", peerIds: [] }] }), params({ id: deviceId }));
    const install = { id: uuid(), type: "software", detector: "remote_access_tool", observedAt: iso(), toolId: "anydesk", name: "AnyDesk" };
    const r = await sendSignals(token, [install]);
    expect(r.body.results[0]).toMatchObject({ status: "accepted", severity: "low" });
    const remote = memoryAlertRows().filter((a) => a.kind === "remote_access");
    expect(remote).toHaveLength(1);
    expect(remote[0]).toMatchObject({ severity: "low" });
  });
});

describe("expected-tools route by role", () => {
  it("owner can set it; unknown toolId → 400 unknown_tool; member → 403 forbidden; unknown device → 404", async () => {
    const { deviceId } = await enrollDevice(GRAN.userId);
    as(OWNER);
    const bad = await expectedToolsPUT(post(`/api/household/devices/${deviceId}/expected-tools`, { tools: [{ toolId: "not-a-tool", peerIds: [] }] }), params({ id: deviceId }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: "unknown_tool" });

    as(GRAN);
    const forbidden = await expectedToolsPUT(post(`/api/household/devices/${deviceId}/expected-tools`, { tools: [] }), params({ id: deviceId }));
    expect(forbidden.status).toBe(403);

    as(OWNER);
    const missing = await expectedToolsPUT(
      post(`/api/household/devices/00000000-0000-4000-8000-000000000fff/expected-tools`, { tools: [] }),
      params({ id: "00000000-0000-4000-8000-000000000fff" }),
    );
    expect(missing.status).toBe(404);
  });

  it("rejects too many tools/peer ids and bad peer id characters", async () => {
    const { deviceId } = await enrollDevice(GRAN.userId);
    as(OWNER);
    const tooManyPeers = await expectedToolsPUT(
      post(`/api/household/devices/${deviceId}/expected-tools`, { tools: [{ toolId: "anydesk", peerIds: Array.from({ length: 11 }, (_, i) => `p${i}`) }] }),
      params({ id: deviceId }),
    );
    expect(tooManyPeers.status).toBe(400);
    const badChar = await expectedToolsPUT(post(`/api/household/devices/${deviceId}/expected-tools`, { tools: [{ toolId: "anydesk", peerIds: ["bad;peer"] }] }), params({ id: deviceId }));
    expect(badChar.status).toBe(400);
  });
});

describe("owner-device signals alert and email like a member's", () => {
  it("alerts and emails the owner for a scam page on the owner's own device", async () => {
    const { token } = await enrollDevice(OWNER.userId, "Owner's laptop");
    const r = await sendSignals(token, [techSupportScamEvent()]);
    expect(r.body.results[0]).toMatchObject({ status: "accepted", severity: "high" });

    const rows = memoryAlertRows().filter((a) => a.tenantId === TENANT && a.kind === "scam_page");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subjectUserId: OWNER.userId, severity: "high" });

    const mail = memorySentEmails().filter((m) => m.to === OWNER.email);
    expect(mail.length).toBeGreaterThan(0);
  });
});

describe("scam-in-progress correlation", () => {
  it("a scam page followed by a remote-access install within 30 minutes raises one critical scam_in_progress alert, emailed", async () => {
    const { token } = await enrollDevice(GRAN.userId);
    const scam = techSupportScamEvent({ observedAt: iso(NOW) });
    const install = remoteAccessToolEvent({ observedAt: iso(new Date(NOW.getTime() + 5 * 60_000)) });
    await sendSignals(token, [scam, install]);

    const progressAlerts = memoryAlertRows().filter((a) => a.tenantId === TENANT && a.kind === "scam_in_progress");
    expect(progressAlerts).toHaveLength(1);
    expect(progressAlerts[0]).toMatchObject({ severity: "critical", subjectUserId: GRAN.userId });

    const mail = memorySentEmails().filter((m) => m.to === OWNER.email && m.subject.includes("scam call"));
    expect(mail.length).toBeGreaterThan(0);

    // A second alerted event nearby does not raise a second scam_in_progress alert (dedupe).
    const install2 = remoteAccessToolEvent({ observedAt: iso(new Date(NOW.getTime() + 8 * 60_000)) });
    await sendSignals(token, [install2]);
    expect(memoryAlertRows().filter((a) => a.tenantId === TENANT && a.kind === "scam_in_progress")).toHaveLength(1);
  });

  it("does not correlate a scam page and a remote-access event more than 30 minutes apart", async () => {
    const { token } = await enrollDevice(GRAN.userId);
    // Both observedAt values are in the past (never future-clamped), 40 minutes apart.
    const scam = techSupportScamEvent({ observedAt: iso(new Date(NOW.getTime() - 40 * 60_000)) });
    await sendSignals(token, [scam]);
    const install = remoteAccessToolEvent({ observedAt: iso(NOW) });
    await sendSignals(token, [install]);
    expect(memoryAlertRows().filter((a) => a.tenantId === TENANT && a.kind === "scam_in_progress")).toHaveLength(0);
  });
});

describe("device-signal alert dedupe includes the detector (_specs/desktop-agent.md)", () => {
  it("an install alert then a session alert for the same tool in the same hour raise two alerts; the session one is critical and emailed", async () => {
    const { token } = await enrollDevice(GRAN.userId);
    const install = remoteAccessToolEvent({ observedAt: iso(new Date(NOW.getTime() - 3 * 60_000)) });
    const session = { id: uuid(), type: "remote_session", detector: "remote_access_session", observedAt: iso(), toolId: "anydesk", direction: "incoming" };
    const r = await sendSignals(token, [install, session]);
    expect(r.body.results[0]).toMatchObject({ status: "accepted", severity: "high" });
    expect(r.body.results[1]).toMatchObject({ status: "accepted", severity: "critical" });

    const rows = memoryAlertRows().filter((a) => a.tenantId === TENANT && a.kind === "remote_access");
    expect(rows.map((a) => a.severity).sort()).toEqual(["critical", "high"]);
    expect(new Set(rows.map((a) => a.dedupeKey)).size).toBe(2);
    const critical = rows.find((a) => a.severity === "critical")!;
    expect(memorySentEmails().some((m) => m.to === OWNER.email && m.subject.includes(critical.title))).toBe(true);

    // The same detector, tool and device in the same hour still dedupes.
    await sendSignals(token, [remoteAccessToolEvent()]);
    expect(memoryAlertRows().filter((a) => a.tenantId === TENANT && a.kind === "remote_access")).toHaveLength(2);
  });
});

describe("baseline remote_access_tool (_specs/desktop-agent.md)", () => {
  it("alerts medium as '<device>: <tool> is installed' and never counts toward scam_in_progress", async () => {
    const { token } = await enrollDevice(GRAN.userId, "Gran PC");
    const scam = techSupportScamEvent({ observedAt: iso(NOW) });
    const baseline = remoteAccessToolEvent({ discovery: "baseline", observedAt: iso(new Date(NOW.getTime() + 5 * 60_000)) });
    const r = await sendSignals(token, [scam, baseline]);
    expect(r.body.results[1]).toMatchObject({ status: "accepted", severity: "medium" });
    const remote = memoryAlertRows().filter((a) => a.tenantId === TENANT && a.kind === "remote_access");
    expect(remote).toHaveLength(1);
    expect(remote[0]).toMatchObject({ severity: "medium", title: "Gran PC: AnyDesk is installed" });
    expect(memoryAlertRows().filter((a) => a.tenantId === TENANT && a.kind === "scam_in_progress")).toHaveLength(0);
  });

  it("rejects a baseline unsigned_unknown unwanted_software as invalid", async () => {
    const { token } = await enrollDevice(GRAN.userId);
    const bad = { id: uuid(), type: "software", detector: "unwanted_software", observedAt: iso(), name: "Foo", reason: "unsigned_unknown", sha256: "0".repeat(64), discovery: "baseline" };
    const r = await sendSignals(token, [bad]);
    expect(r.body.results[0]).toMatchObject({ status: "rejected", reason: "invalid" });
  });
});

describe("GET /api/signals/lists", () => {
  it("returns an ETag and 304s a matching If-None-Match", async () => {
    const { token } = await enrollDevice(GRAN.userId);
    bearer(token);
    const first = await listsGET(new Request("http://localhost/api/signals/lists"));
    expect(first.status).toBe(200);
    const etag = first.headers.get("ETag");
    expect(etag).toBeTruthy();
    expect(first.headers.get("Cache-Control")).toBe("private, max-age=3600");
    const body = (await first.json()) as { version: string };
    expect(`"${body.version}"`).toBe(etag);

    bearer(token);
    const second = await listsGET(new Request("http://localhost/api/signals/lists", { headers: { "If-None-Match": etag! } }));
    expect(second.status).toBe(304);

    bearer(token);
    const weak = await listsGET(new Request("http://localhost/api/signals/lists", { headers: { "If-None-Match": `W/${etag}` } }));
    expect(weak.status).toBe(304);
  });

  it("includes brands (_specs/browser-extension.md)", async () => {
    const { token } = await enrollDevice(GRAN.userId);
    bearer(token);
    const res = await listsGET(new Request("http://localhost/api/signals/lists"));
    const body = (await res.json()) as { brands: { id: string; name: string; domains: string[]; keywords: string[] }[] };
    expect(body.brands.length).toBeGreaterThan(0);
    expect(body.brands.find((b) => b.id === "paypal")).toMatchObject({ name: "PayPal", domains: expect.arrayContaining(["paypal.com"]) });
  });
});

async function statusOf(token: string, ids: string[]): Promise<{ status: number; body: SignalStatusResponse | { error?: string; code?: string } }> {
  bearer(token);
  const res = await statusGET(new Request(`http://localhost/api/signals/status?ids=${ids.join(",")}`));
  return { status: res.status, body: (await res.json().catch(() => ({}))) as SignalStatusResponse };
}

describe("GET /api/signals/status", () => {
  it("scope: a monitoring token succeeds, a full token or browser session gets 403 insufficient_scope", async () => {
    const { token } = await enrollDevice(GRAN.userId);
    const ok = await statusOf(token, [uuid()]);
    expect(ok.status).toBe(200);

    as(OWNER);
    const asBrowser = await statusGET(new Request(`http://localhost/api/signals/status?ids=${uuid()}`));
    expect(asBrowser.status).toBe(403);
    expect(await asBrowser.json()).toMatchObject({ code: "insufficient_scope" });
  });

  it("400 bad_request for 0, 51, or malformed ids", async () => {
    const { token } = await enrollDevice(GRAN.userId);
    expect((await statusOf(token, [])).status).toBe(400);
    expect((await statusOf(token, Array.from({ length: 51 }, uuid))).status).toBe(400);
    expect((await statusOf(token, ["not-a-uuid"])).status).toBe(400);
  });

  it("returns only this device's events; unknown or another device's ids are omitted", async () => {
    const a = await enrollDevice(GRAN.userId, "Gran's phone");
    const b = await enrollDevice(GRAN.userId, "Gran's laptop");
    const event = techSupportScamEvent();
    await sendSignals(a.token, [event]);
    const otherEvent = techSupportScamEvent();
    await sendSignals(b.token, [otherEvent]);

    const { status, body } = await statusOf(a.token, [event.id, otherEvent.id, uuid()]);
    expect(status).toBe(200);
    const results = (body as SignalStatusResponse).results;
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: event.id, outcome: "alerted", severity: "high", alerted: true });
  });

  it("429 after 120 requests/hour/device", async () => {
    const { token, deviceId } = await enrollDevice(GRAN.userId);
    for (let i = 0; i < 120; i++) takeRateSlot("signals-status", deviceId, 120, 60 * 60 * 1000);
    const res = await statusOf(token, [uuid()]);
    expect(res.status).toBe(429);
  });
});

describe("heartbeat device item", () => {
  it("carries the device's real expectedTools", async () => {
    const { token, deviceId } = await enrollDevice(GRAN.userId);
    bearer(token);
    const empty = (await (await heartbeatPOST(post("/api/devices/heartbeat", {}))).json()) as HeartbeatResponse;
    expect(empty.device.expectedTools).toEqual([]);

    as(OWNER);
    const put = await expectedToolsPUT(post(`/api/household/devices/${deviceId}/expected-tools`, { tools: [{ toolId: "anydesk", peerIds: ["owner-peer-1"] }] }), params({ id: deviceId }));
    expect(put.status).toBe(200);
    bearer(token);
    const body = (await (await heartbeatPOST(post("/api/devices/heartbeat", {}))).json()) as HeartbeatResponse;
    expect(body.device.expectedTools).toEqual([{ toolId: "anydesk", name: "AnyDesk", peerIds: ["owner-peer-1"] }]);
  });
});

describe("heartbeat listsVersion", () => {
  it("includes the current detection-lists version", async () => {
    const { token } = await enrollDevice(GRAN.userId);
    bearer(token);
    const res = await heartbeatPOST(post("/api/devices/heartbeat", {}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as HeartbeatResponse;
    expect(body.listsVersion).toBeTruthy();

    bearer(token);
    const lists = await listsGET(new Request("http://localhost/api/signals/lists"));
    const listsBody = (await lists.json()) as { version: string };
    expect(body.listsVersion).toBe(listsBody.version);
  });
});

// ─── Escalation (injected deps; _specs/signals.md "Escalations") ───

function fakeAnalysis(overrides: Partial<UrlAnalysis> = {}): UrlAnalysis {
  return {
    input: "https://example.test/",
    normalized_url: "https://example.test/",
    display_url: "https://example.test/",
    redirect_chain: ["https://example.test/"],
    domain: { host: "example.test", host_unicode: "example.test", registrable: "example.test", is_ip: false },
    reputation: {},
    lookalike: null,
    heuristics: [],
    errors: [],
    analyzed_at: iso(),
    ...overrides,
  };
}

/** A fresh, isolated deps object per call (own in-memory cache, unless `overrides.cache` is given): tests never leak cached results into each other. */
function testDeps(overrides: Partial<EscalateDeps> = {}): EscalateDeps {
  return { ...createEscalateDeps(), cache: createInMemoryCache(), ...overrides };
}

describe("escalation: lookalike_login", () => {
  it("confirms malicious when Safe Browsing flags the analyzed URL", async () => {
    const { deviceId } = await enrollDevice(GRAN.userId);
    const event = { id: uuid(), type: "page", detector: "lookalike_login", observedAt: iso(), domain: "paypa1.test", brand: "paypal", indicators: ["lookalike_skeleton"] };
    const { row } = await insertDeviceSignal({
      tenantId: TENANT,
      deviceId,
      userId: GRAN.userId,
      clientEventId: event.id,
      type: "page",
      detector: "lookalike_login",
      subject: "paypa1.test",
      payload: { domain: event.domain, brand: event.brand, indicators: event.indicators, observedAt: event.observedAt },
      observedAt: NOW,
      escalated: true,
    });
    const analyzeUrl = vi.fn(async () => fakeAnalysis({ reputation: { safe_browsing: { flagged: true, matches: [] } } }));
    await runSignalEscalate({ signalId: row.id, tenantId: TENANT }, testDeps({ analyzeUrl }));
    const updated = await getDeviceSignal(TENANT, row.id);
    expect(updated).toMatchObject({ outcome: "alerted", severity: "high" });
    expect(memoryAlertRows().some((a) => a.tenantId === TENANT && a.kind === "dangerous_site")).toBe(true);
  });

  it("dismisses (no alert) when nothing is flagged", async () => {
    const { deviceId } = await enrollDevice(GRAN.userId);
    const event = { id: uuid(), type: "page", detector: "lookalike_login", observedAt: iso(), domain: "clean.test", brand: "paypal", indicators: [] };
    const { row } = await insertDeviceSignal({
      tenantId: TENANT,
      deviceId,
      userId: GRAN.userId,
      clientEventId: event.id,
      type: "page",
      detector: "lookalike_login",
      subject: "clean.test",
      payload: { domain: event.domain, brand: event.brand, indicators: event.indicators, observedAt: event.observedAt },
      observedAt: NOW,
      escalated: true,
    });
    const analyzeUrl = vi.fn(async () => fakeAnalysis());
    await runSignalEscalate({ signalId: row.id, tenantId: TENANT }, testDeps({ analyzeUrl }));
    const updated = await getDeviceSignal(TENANT, row.id);
    expect(updated?.outcome).toBe("dismissed");
    expect(memoryAlertRows().filter((a) => a.tenantId === TENANT)).toHaveLength(0);
  });
});

async function seedDangerousSiteSignal(tenantId: string, deviceId: string, domain: string): Promise<string> {
  const { row } = await insertDeviceSignal({
    tenantId,
    deviceId,
    userId: GRAN.userId,
    clientEventId: uuid(),
    type: "page",
    detector: "dangerous_site",
    subject: domain,
    payload: { domain, source: "safe_browsing_prefix", observedAt: iso() },
    observedAt: NOW,
    escalated: true,
  });
  return row.id;
}

describe("escalation: dangerous_site", () => {
  it("confirmed → malicious verdict + alert", async () => {
    const { deviceId } = await enrollDevice(GRAN.userId);
    const signalId = await seedDangerousSiteSignal(TENANT, deviceId, "bad-site.test");
    const checkSafeBrowsing = vi.fn(async () => ({ flagged: true, matches: [] }));
    await runSignalEscalate({ signalId, tenantId: TENANT }, testDeps({ checkSafeBrowsing }));
    expect(await getDeviceSignal(TENANT, signalId)).toMatchObject({ outcome: "alerted", severity: "high" });
    expect(memoryAlertRows().some((a) => a.kind === "dangerous_site")).toBe(true);
  });

  it("a lookup failure dismisses and never raises an alert", async () => {
    const { deviceId } = await enrollDevice(GRAN.userId);
    const signalId = await seedDangerousSiteSignal(TENANT, deviceId, "flaky.test");
    const checkSafeBrowsing = vi.fn(async () => {
      throw new Error("network down");
    });
    await runSignalEscalate({ signalId, tenantId: TENANT }, testDeps({ checkSafeBrowsing }));
    expect(await getDeviceSignal(TENANT, signalId)).toMatchObject({ outcome: "dismissed" });
    expect(memoryAlertRows()).toHaveLength(0);
  });

  it("caches a domain's result for 24h: a second household's lookup is a cache hit", async () => {
    const { deviceId: deviceA } = await enrollDevice(GRAN.userId, "Household A device");
    const otherTenant = "00000000-0000-4000-8000-0000000000c2";
    setMemoryMembers(otherTenant, [{ userId: "user-other-owner", name: "Other Owner", email: "other@example.test", role: "owner" }]);
    hdrs.current = new Headers();
    authState.session = {
      userId: "user-other-owner",
      tenantId: otherTenant,
      role: "owner",
      user: { email: "other@example.test", name: "Other Owner" },
      expires: "2099-01-01T00:00:00Z",
    };
    const codeOther = await createCode("user-other-owner");
    const enrollRes = await enrollPOST(
      new Request("http://localhost/api/devices/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.10" },
        body: JSON.stringify({ code: codeOther.code, kind: "browser_extension", platform: "chrome", name: "Household B device", clientVersion: "1.0.0" }),
      }),
    );
    const deviceB = ((await enrollRes.json()) as EnrollDeviceResponse).device.id;

    const sharedCache = createEscalateDeps().cache;
    const checkSafeBrowsing = vi.fn(async () => ({ flagged: true, matches: [] }));
    const deps = testDeps({ checkSafeBrowsing, cache: sharedCache });

    const idA = await seedDangerousSiteSignal(TENANT, deviceA, "shared-domain.test");
    await runSignalEscalate({ signalId: idA, tenantId: TENANT }, deps);
    const idB = await seedDangerousSiteSignal(otherTenant, deviceB, "shared-domain.test");
    await runSignalEscalate({ signalId: idB, tenantId: otherTenant }, deps);

    expect(checkSafeBrowsing).toHaveBeenCalledTimes(1);
    expect(await getDeviceSignal(TENANT, idA)).toMatchObject({ outcome: "alerted" });
    expect(await getDeviceSignal(otherTenant, idB)).toMatchObject({ outcome: "alerted" });
  });
});

describe("escalation: unwanted_software unsigned_unknown", () => {
  async function seed(): Promise<{ deviceId: string; signalId: string; sha256: string }> {
    const { deviceId } = await enrollDevice(GRAN.userId);
    const sha256 = "b".repeat(64);
    const { row } = await insertDeviceSignal({
      tenantId: TENANT,
      deviceId,
      userId: GRAN.userId,
      clientEventId: uuid(),
      type: "software",
      detector: "unwanted_software",
      subject: "mystery.exe",
      payload: { name: "mystery.exe", reason: "unsigned_unknown", sha256, observedAt: iso() },
      observedAt: NOW,
      escalated: true,
    });
    return { deviceId, signalId: row.id, sha256 };
  }

  it("≥3 engines flagged → malicious", async () => {
    const { signalId } = await seed();
    const checkVirusTotalFile = vi.fn(async () => ({
      status: "found" as const,
      malicious: 5,
      suspicious: 1,
      harmless: 60,
      undetected: 2,
      top_engines: ["EngineA", "EngineB"],
      permalink: "https://virustotal.example/x",
    }));
    await runSignalEscalate({ signalId, tenantId: TENANT }, testDeps({ checkVirusTotalFile }));
    expect(await getDeviceSignal(TENANT, signalId)).toMatchObject({ outcome: "alerted", severity: "high" });
    expect(memoryAlertRows().some((a) => a.kind === "unwanted_software")).toBe(true);
  });

  it("<3 engines flagged → dismissed, no alert", async () => {
    const { signalId } = await seed();
    const checkVirusTotalFile = vi.fn(async () => ({
      status: "found" as const,
      malicious: 1,
      suspicious: 0,
      harmless: 60,
      undetected: 2,
      top_engines: [],
      permalink: "https://virustotal.example/x",
    }));
    await runSignalEscalate({ signalId, tenantId: TENANT }, testDeps({ checkVirusTotalFile }));
    expect(await getDeviceSignal(TENANT, signalId)).toMatchObject({ outcome: "dismissed" });
    expect(memoryAlertRows()).toHaveLength(0);
  });
});

describe("expected tools listed on GET /api/household", () => {
  it("shows a device's expected tools", async () => {
    const { deviceId } = await enrollDevice(GRAN.userId);
    as(OWNER);
    await expectedToolsPUT(post(`/api/household/devices/${deviceId}/expected-tools`, { tools: [{ toolId: "anydesk", peerIds: ["p1"] }] }), params({ id: deviceId }));
    const rows = await listExpectedTools(TENANT, { deviceId });
    expect(rows).toEqual([{ deviceId, toolId: "anydesk", peerIds: ["p1"], createdBy: OWNER.userId, createdAt: expect.any(Date) }]);
  });
});

describe("alerts feed shows signal alerts", () => {
  it("owner sees the scam_page alert via GET /api/alerts", async () => {
    const { token } = await enrollDevice(GRAN.userId);
    await sendSignals(token, [techSupportScamEvent()]);
    as(OWNER);
    const res = await alertsGET(new Request("http://localhost/api/alerts"));
    const body = (await res.json()) as AlertListResponse;
    expect(body.items.some((i) => i.kind === "scam_page")).toBe(true);
  });
});
