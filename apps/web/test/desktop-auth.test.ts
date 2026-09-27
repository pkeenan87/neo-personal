// @vitest-environment node
/**
 * Desktop device authorization end to end on the in-memory stores:
 * start → pending → approve in the browser → redeem once → the token
 * authenticates API calls as the approver → it can revoke only itself.
 */
import type { Session } from "next-auth";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as approvePOST } from "@/app/api/desktop/device/approve/route";
import { POST as startPOST } from "@/app/api/desktop/device/route";
import { POST as redeemPOST } from "@/app/api/desktop/device/token/route";
import { DELETE as tokensDELETE, GET as tokensGET, POST as tokensPOST } from "@/app/api/settings/desktop-tokens/route";
import { GET as usageGET } from "@/app/api/usage/route";
import type { DeviceAuthRedeemResponse, DeviceAuthStartResponse } from "@/lib/desktop-auth-types";
import type { DesktopTokenListResponse } from "@/lib/desktop-token-types";
import { DesktopAuthorizeView } from "@/components/DesktopAuthorize";
import type { DeviceAuthDeviceInput } from "@/lib/desktop-auth-types";
import { DEVICE_DECIDE_LIMIT, DEVICE_START_LIMIT, lookupDeviceAuth } from "@/lib/server/desktop-auth";
import { memoryEnrollSelfDevice, memoryListDevices, resetMemoryDevices } from "@/lib/server/memory-devices";
import { resetMemoryDesktopAuth } from "@/lib/server/memory-desktop-auth";
import { resetRateLimits } from "@/lib/server/rate-limit";
import { DEV_SESSION_IDS, getSession } from "@/lib/session";
import { post, resetMemoryState, stubBaseEnv } from "./helpers/routes";

// Request headers seen by lib/session.ts (Bearer tokens) are injected here.
const hdrs = vi.hoisted(() => ({ current: new Headers() }));
vi.mock("next/headers", () => ({
  headers: async () => hdrs.current,
  cookies: async () => ({ get: () => undefined, getAll: () => [] }),
}));
const authState = vi.hoisted(() => ({ session: null as Session | null }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => authState.session) }));

function bearer(token: string): void {
  hdrs.current = new Headers({ authorization: `Bearer ${token}` });
}

function fromIp(url: string, body: unknown, ip: string): Request {
  const req = post(url, body);
  return new Request(req, { headers: { ...Object.fromEntries(req.headers), "x-forwarded-for": ip } });
}

async function start(name = "NeoShield on laptop"): Promise<DeviceAuthStartResponse> {
  const res = await startPOST(post("/api/desktop/device", { clientName: name }));
  expect(res.status).toBe(201);
  return (await res.json()) as DeviceAuthStartResponse;
}

beforeEach(() => {
  stubBaseEnv(vi);
  resetMemoryState();
  resetMemoryDesktopAuth();
  resetMemoryDevices();
  resetRateLimits();
  hdrs.current = new Headers();
  authState.session = null;
  const g = globalThis as { __neoDesktopTokens?: unknown };
  g.__neoDesktopTokens = undefined;
});
afterEach(() => vi.unstubAllEnvs());

describe("device authorization flow", () => {
  it("issues codes, waits for approval, then delivers a token exactly once", async () => {
    const started = await start();
    expect(started.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(started.deviceCode).toMatch(/^neo_dc_/);
    expect(started.verificationUri).toBe("http://localhost/desktop/authorize");
    expect(started.verificationUriComplete).toBe(`http://localhost/desktop/authorize?code=${started.userCode}`);
    expect(started.expiresIn).toBe(600);
    expect(started.interval).toBe(5);

    const pending = await redeemPOST(post("/api/desktop/device/token", { deviceCode: started.deviceCode }));
    expect(pending.status).toBe(202);
    expect(await pending.json()).toMatchObject({ status: "pending", interval: 5 });

    // The dev-bypass session approves in the browser (typed lower case, no dash).
    const approved = await approvePOST(post("/api/desktop/device/approve", { userCode: started.userCode.toLowerCase().replace("-", ""), approve: true }));
    expect(approved.status).toBe(200);
    expect(await approved.json()).toEqual({ status: "approved", clientName: "NeoShield on laptop" });
    expect((await approvePOST(post("/api/desktop/device/approve", { userCode: started.userCode, approve: true }))).status).toBe(409);

    const redeemed = await redeemPOST(post("/api/desktop/device/token", { deviceCode: started.deviceCode }));
    expect(redeemed.status).toBe(200);
    const body = (await redeemed.json()) as DeviceAuthRedeemResponse;
    expect(body).toMatchObject({ status: "approved", clientName: "NeoShield on laptop", email: "dev@neo.local", name: "Dev User", scopes: ["full"], device: null });
    expect(body.token).toMatch(/^neo_dt_[A-Za-z0-9_-]{43}$/);

    // One-shot delivery.
    expect((await redeemPOST(post("/api/desktop/device/token", { deviceCode: started.deviceCode }))).status).toBe(404);

    // The token shows up in Settings → Desktop, named after the client.
    const list = (await (await tokensGET()).json()) as DesktopTokenListResponse;
    expect(list.tokens).toHaveLength(1);
    expect(list.tokens[0]).toMatchObject({ id: body.tokenId, name: "NeoShield on laptop" });

    // Without the dev bypass, the Bearer token is the session.
    vi.stubEnv("DEV_AUTH_BYPASS", "false");
    expect((await usageGET()).status).toBe(401);
    bearer(body.token);
    expect(await getSession()).toMatchObject({ ...DEV_SESSION_IDS, role: "owner", desktopTokenId: body.tokenId });
    expect((await usageGET()).status).toBe(200);

    // A desktop token cannot manage tokens, except revoking itself.
    expect((await tokensGET()).status).toBe(403);
    expect((await tokensPOST(post("/api/settings/desktop-tokens", { name: "escalate" }))).status).toBe(403);
    expect((await approvePOST(post("/api/desktop/device/approve", { userCode: "BCDF-2346", approve: true }))).status).toBe(403);
    const other = crypto.randomUUID();
    expect((await tokensDELETE(new Request(`http://localhost/api/settings/desktop-tokens?id=${other}`, { method: "DELETE" }))).status).toBe(403);
    expect((await tokensDELETE(new Request(`http://localhost/api/settings/desktop-tokens?id=${body.tokenId}`, { method: "DELETE" }))).status).toBe(200);
    expect((await usageGET()).status).toBe(401);
  });

  it("reports a denial once and never mints a token", async () => {
    const started = await start("Other machine");
    const denied = await approvePOST(post("/api/desktop/device/approve", { userCode: started.userCode, approve: false }));
    expect(await denied.json()).toEqual({ status: "denied", clientName: "Other machine" });
    expect((await redeemPOST(post("/api/desktop/device/token", { deviceCode: started.deviceCode }))).status).toBe(403);
    expect((await redeemPOST(post("/api/desktop/device/token", { deviceCode: started.deviceCode }))).status).toBe(404);
    const list = (await (await tokensGET()).json()) as DesktopTokenListResponse;
    expect(list.tokens).toHaveLength(0);
  });

  it("validates input and rejects unknown codes", async () => {
    expect((await startPOST(post("/api/desktop/device", { clientName: 42 }))).status).toBe(400);
    expect((await startPOST(post("/api/desktop/device", { clientName: "\u0001" }))).status).toBe(400);
    const unnamed = await startPOST(new Request("http://localhost/api/desktop/device", { method: "POST" }));
    expect(unnamed.status).toBe(201);
    expect((await redeemPOST(post("/api/desktop/device/token", {}))).status).toBe(400);
    expect((await redeemPOST(post("/api/desktop/device/token", { deviceCode: "neo_dc_" + "x".repeat(43) }))).status).toBe(404);
    expect((await approvePOST(post("/api/desktop/device/approve", { userCode: "ZZZZ-ZZZZ", approve: true }))).status).toBe(404);
    expect((await approvePOST(post("/api/desktop/device/approve", { userCode: "ZZZZ-ZZZZ" }))).status).toBe(400);
  });

  it("needs a session to approve", async () => {
    vi.stubEnv("DEV_AUTH_BYPASS", "false");
    expect((await approvePOST(post("/api/desktop/device/approve", { userCode: "BCDF-2346", approve: true }))).status).toBe(401);
    // Starting and polling need none.
    expect((await startPOST(post("/api/desktop/device", {}))).status).toBe(201);
  });

  it("rate limits starts per IP and approvals per user", async () => {
    for (let i = 0; i < DEVICE_START_LIMIT.limit; i++) {
      expect((await startPOST(fromIp("/api/desktop/device", {}, "203.0.113.7"))).status).toBe(201);
    }
    const limited = await startPOST(fromIp("/api/desktop/device", {}, "203.0.113.7"));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect((await startPOST(fromIp("/api/desktop/device", {}, "203.0.113.8"))).status).toBe(201);

    for (let i = 0; i < DEVICE_DECIDE_LIMIT.limit; i++) {
      expect((await approvePOST(post("/api/desktop/device/approve", { userCode: "ZZZZ-ZZZZ", approve: true }))).status).toBe(404);
    }
    expect((await approvePOST(post("/api/desktop/device/approve", { userCode: "ZZZZ-ZZZZ", approve: true }))).status).toBe(429);
  });

  const DEVICE: DeviceAuthDeviceInput = { kind: "browser_extension", platform: "chrome", name: "Chrome on Grandma's laptop", clientVersion: "0.1.0" };

  it("enrolls a device and mints a monitoring token for a request with a device", async () => {
    const res = await startPOST(post("/api/desktop/device", { clientName: "Neo extension", device: DEVICE }));
    expect(res.status).toBe(201);
    const started = (await res.json()) as DeviceAuthStartResponse;

    // The approval page's lookup exposes the device.
    const lookup = await lookupDeviceAuth(started.userCode);
    expect(lookup).toMatchObject({ clientName: "Neo extension", status: "pending", device: DEVICE });

    expect((await approvePOST(post("/api/desktop/device/approve", { userCode: started.userCode, approve: true }))).status).toBe(200);
    const redeemed = await redeemPOST(post("/api/desktop/device/token", { deviceCode: started.deviceCode }));
    expect(redeemed.status).toBe(200);
    const body = (await redeemed.json()) as DeviceAuthRedeemResponse;
    expect(body.scopes).toEqual(["device", "signals:write", "url:check"]);
    expect(body.device).toMatchObject({
      userId: DEV_SESSION_IDS.userId,
      kind: "browser_extension",
      platform: "chrome",
      name: "Chrome on Grandma's laptop",
      clientVersion: "0.1.0",
      enrollment: "self",
      lastSeenAt: null,
      status: "never_seen",
    });

    // A device, not a desktop token: Settings → Desktop does not list it.
    expect(memoryListDevices(DEV_SESSION_IDS.tenantId).map((d) => d.id)).toEqual([body.device!.id]);
    const list = (await (await tokensGET()).json()) as DesktopTokenListResponse;
    expect(list.tokens).toHaveLength(0);

    // It resolves only for its own scopes.
    vi.stubEnv("DEV_AUTH_BYPASS", "false");
    bearer(body.token);
    expect(await getSession()).toBeNull();
    expect(await getSession({ scope: "device" })).toMatchObject({ deviceId: body.device!.id, desktopTokenId: body.tokenId });
    const usage = await usageGET();
    expect(usage.status).toBe(403);
    expect(await usage.json()).toMatchObject({ code: "insufficient_scope" });
  });

  it("rejects a malformed device with 400", async () => {
    for (const device of [
      null,
      "chrome",
      { ...DEVICE, kind: "phone" },
      { ...DEVICE, platform: "android" },
      { ...DEVICE, name: "" },
      { ...DEVICE, name: "x".repeat(65) },
      { ...DEVICE, clientVersion: "" },
      { kind: DEVICE.kind, platform: DEVICE.platform, name: DEVICE.name },
    ]) {
      const res = await startPOST(post("/api/desktop/device", { clientName: "Neo extension", device }));
      expect(res.status, JSON.stringify(device)).toBe(400);
      expect(await res.json()).toMatchObject({ code: "bad_request" });
    }
  });

  it("returns 409 device_limit when the household is full", async () => {
    for (let i = 0; i < 20; i++) {
      const r = memoryEnrollSelfDevice({ ...DEV_SESSION_IDS, role: "owner", device: { ...DEVICE, name: `Device ${i}` } });
      expect("error" in r).toBe(false);
    }
    const s = (await (await startPOST(post("/api/desktop/device", { device: DEVICE }))).json()) as DeviceAuthStartResponse;
    expect((await approvePOST(post("/api/desktop/device/approve", { userCode: s.userCode, approve: true }))).status).toBe(200);
    const full = await redeemPOST(post("/api/desktop/device/token", { deviceCode: s.deviceCode }));
    expect(full.status).toBe(409);
    expect(await full.json()).toMatchObject({ code: "device_limit" });
  });

  it("the approval page names what is granted", () => {
    const base = { code: "BCDF-2346", invalidInput: false, unavailable: false, account: { email: "dev@neo.local", name: "Dev User" } };
    const monitoring = renderToStaticMarkup(
      createElement(DesktopAuthorizeView, {
        ...base,
        request: { clientName: "Neo extension", expiresAt: new Date().toISOString(), status: "pending", device: DEVICE, householdName: "Dev household" },
      }),
    );
    expect(monitoring).toContain("report scam warnings from this device to <strong>Dev household</strong>. It cannot read your checks or chats.");
    expect(monitoring).toContain("Chrome on Grandma&#x27;s laptop");
    expect(monitoring).toContain("Chrome browser extension");
    expect(monitoring).not.toContain("Full access");

    const full = renderToStaticMarkup(
      createElement(DesktopAuthorizeView, {
        ...base,
        request: { clientName: "NeoShield on laptop", expiresAt: new Date().toISOString(), status: "pending", device: null, householdName: null },
      }),
    );
    expect(full).toContain("Full access to your Neo account.");
    expect(full).not.toContain("report scam warnings");
  });
});
