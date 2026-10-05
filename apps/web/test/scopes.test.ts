// @vitest-environment node
/**
 * Token scopes (_specs/device-enrollment.md): a monitoring token (device, signals:write,
 * url:check) gets 403 `insufficient_scope` from every authenticated API route and cannot
 * render a page; a full token keeps working. The route list is walked from disk, so new
 * routes are covered automatically.
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import type { Session } from "next-auth";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as signalsPOST } from "@/app/api/signals/route";
import { GET as signalsListsGET } from "@/app/api/signals/lists/route";
import { GET as signalsStatusGET } from "@/app/api/signals/status/route";
import { POST as checkUrlPOST } from "@/app/api/devices/check-url/route";
import { memoryCreateDesktopToken, memoryInsertDeviceToken } from "@/lib/server/memory-desktop-tokens";
import {
  memoryCreateEnrollmentCode,
  memoryListPendingEnrollmentCodes,
  memoryRedeemEnrollmentCode,
  memoryRevokeDevice,
  resetMemoryDevices,
} from "@/lib/server/memory-devices";
import { memoryRemoveMember } from "@/lib/server/memory-household";
import { resetMemorySignals } from "@/lib/server/memory-signals";
import { setMemoryMembers } from "@/lib/server/memory-state";
import { resetRateLimits } from "@/lib/server/rate-limit";
import { DEV_SESSION_IDS, getSession, requireApiSession, requireBrowserApiSession, requireSession } from "@/lib/session";
import { post, resetMemoryState, stubBaseEnv } from "./helpers/routes";

const hdrs = vi.hoisted(() => ({ current: new Headers() }));
vi.mock("next/headers", () => ({
  headers: async () => hdrs.current,
  cookies: async () => ({ get: () => undefined, getAll: () => [] }),
}));
const authState = vi.hoisted(() => ({ session: null as Session | null }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => authState.session) }));

const API_DIR = path.resolve(__dirname, "../app/api");
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/**
 * Routes that take no session, or a device-scoped one: sign-in, webhooks, health, the
 * device-authorization start/poll, and everything under api/devices/ (enrollment is
 * unauthenticated; heartbeat and self-unenroll need scope `device`).
 *
 * `signals` and `signals/lists` are also excluded from the generic walk below: unlike every
 * other route, they do NOT use the default `full` scope, so a monitoring token (which holds
 * `signals:write` and `device`) is expected to succeed there, not get 403, and a full-scope
 * token/browser session is expected to get 403, not succeed. That is the opposite of what the
 * two generic tests below assert for every other route, so `signals` gets its own explicit
 * assertions instead (describe("device signal routes") below).
 */
const UNAUTHENTICATED = [
  /^auth\//,
  /^inngest$/,
  /^health$/,
  /^inbound\//,
  /^digest\/unsubscribe$/,
  /^desktop\/device$/,
  /^desktop\/device\/token$/,
  /^devices(\/|$)/,
  /^signals(\/|$)/,
];

function routeDirs(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...routeDirs(path.join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name));
    else if (entry.name === "route.ts" && prefix) out.push(prefix);
  }
  return out;
}

const ROUTES = routeDirs(API_DIR)
  .filter((r) => !UNAUTHENTICATED.some((re) => re.test(r)))
  .sort();

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
interface RouteCase {
  route: string;
  method: (typeof METHODS)[number];
  handler: Handler;
}

const PARAM = "00000000-0000-4000-8000-000000000999";
const ctx = () => ({ params: Promise.resolve(new Proxy({}, { get: () => PARAM }) as Record<string, string>) });

function requestFor(route: string, method: string): Request {
  const url = `http://localhost/api/${route.replace(/\[[^\]]+\]/g, PARAM)}`;
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(method === "GET" || method === "DELETE" ? {} : { body: "{}" }),
  });
}

const cases: RouteCase[] = [];

beforeAll(async () => {
  for (const route of ROUTES) {
    const mod = (await import(path.join(API_DIR, route, "route.ts"))) as Record<string, unknown>;
    for (const method of METHODS) {
      if (typeof mod[method] === "function") cases.push({ route, method, handler: mod[method] as Handler });
    }
  }
}, 60_000);

function bearer(token: string): void {
  hdrs.current = new Headers({ authorization: `Bearer ${token}` });
}

function enrollMonitoringDevice(): { token: string; deviceId: string } {
  const created = memoryCreateEnrollmentCode({ tenantId: DEV_SESSION_IDS.tenantId, userId: DEV_SESSION_IDS.userId, createdBy: DEV_SESSION_IDS.userId });
  if ("error" in created) throw new Error(created.error);
  const redeemed = memoryRedeemEnrollmentCode({
    code: created.code.toLowerCase(),
    device: { kind: "browser_extension", platform: "chrome", name: "Chrome on the laptop", clientVersion: "0.1.0" },
  });
  if (redeemed.status !== "enrolled") throw new Error(redeemed.status);
  return { token: redeemed.token, deviceId: redeemed.device.id };
}

beforeEach(() => {
  stubBaseEnv(vi);
  vi.stubEnv("DEV_AUTH_BYPASS", "false");
  resetMemoryState();
  resetMemoryDevices();
  resetMemorySignals();
  resetRateLimits();
  (globalThis as { __neoDesktopTokens?: unknown }).__neoDesktopTokens = undefined;
  hdrs.current = new Headers();
  authState.session = null;
});
afterEach(() => vi.unstubAllEnvs());

describe("route list", () => {
  it("finds the authenticated routes and skips the unauthenticated ones", () => {
    expect(cases.length).toBeGreaterThan(25);
    const routes = new Set(cases.map((c) => c.route));
    for (const r of ["verdicts", "agent", "household", "settings/desktop-tokens", "desktop/device/approve", "invites/[secret]"]) expect(routes).toContain(r);
    for (const r of ["health", "inngest", "desktop/device", "desktop/device/token", "inbound/resend", "digest/unsubscribe"]) expect(routes).not.toContain(r);
  });
});

describe("a monitoring token", () => {
  it("gets 403 insufficient_scope from every authenticated API route", async () => {
    const { token } = enrollMonitoringDevice();
    const failures: string[] = [];
    for (const c of cases) {
      bearer(token);
      const res = await c.handler(requestFor(c.route, c.method), ctx());
      const body = (await res.clone().json().catch(() => ({}))) as { code?: string };
      if (res.status !== 403 || body.code !== "insufficient_scope") failures.push(`${c.method} /api/${c.route} → ${res.status} ${body.code ?? ""}`);
    }
    expect(failures).toEqual([]);
  });

  it("also under DEV_AUTH_BYPASS: a Bearer token is resolved as itself", async () => {
    vi.stubEnv("DEV_AUTH_BYPASS", "true");
    const { token } = enrollMonitoringDevice();
    bearer(token);
    expect(await getSession()).toBeNull();
    const r = await requireApiSession();
    expect(r.response?.status).toBe(403);
  });

  it("resolves only for its own scopes, with the device id", async () => {
    const { token, deviceId } = enrollMonitoringDevice();
    bearer(token);
    expect(await getSession()).toBeNull();
    expect(await getSession({ scope: "full" })).toBeNull();
    const s = await getSession({ scope: "device" });
    expect(s).toMatchObject({ ...DEV_SESSION_IDS, role: "owner", scopes: ["device", "signals:write", "url:check"], deviceId });
    expect(s?.desktopTokenId).toBeTruthy();
    expect(await getSession({ scope: "signals:write" })).not.toBeNull();
    expect((await requireApiSession({ scope: "device" })).session?.deviceId).toBe(deviceId);

    const browserOnly = await requireBrowserApiSession();
    expect(browserOnly.response?.status).toBe(403);
    expect(await browserOnly.response?.json()).toMatchObject({ code: "insufficient_scope" });
  });

  it("is treated as signed out by pages", async () => {
    const { token } = enrollMonitoringDevice();
    bearer(token);
    await expect(requireSession("/dashboard")).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_REDIRECT") });
  });

  it("stops resolving once its device is revoked", async () => {
    const { token, deviceId } = enrollMonitoringDevice();
    bearer(token);
    expect(await getSession({ scope: "device" })).not.toBeNull();
    memoryRevokeDevice({ tenantId: DEV_SESSION_IDS.tenantId, deviceId, revokedBy: DEV_SESSION_IDS.userId });
    expect(await getSession({ scope: "device" })).toBeNull();
    const r = await requireApiSession({ scope: "device" });
    expect(r.response?.status).toBe(401);
  });
});

describe("detaching a member", () => {
  it("revokes their devices, tokens and pending codes", async () => {
    const tenantId = DEV_SESSION_IDS.tenantId;
    setMemoryMembers(tenantId, [
      { userId: DEV_SESSION_IDS.userId, name: "Dev User", email: "dev@neo.local", role: "owner" },
      { userId: "user-gran", name: "Gran", email: "gran@example.test", role: "member" },
    ]);
    const code = memoryCreateEnrollmentCode({ tenantId, userId: "user-gran", createdBy: DEV_SESSION_IDS.userId });
    if ("error" in code) throw new Error(code.error);
    const redeemed = memoryRedeemEnrollmentCode({
      code: code.code,
      device: { kind: "desktop_agent", platform: "windows", name: "Gran's PC", clientVersion: "1.0.0" },
    });
    if (redeemed.status !== "enrolled") throw new Error(redeemed.status);
    expect(redeemed.device).toMatchObject({ memberName: "Gran", enrolledByName: "Dev User", enrollment: "code" });
    memoryCreateEnrollmentCode({ tenantId, userId: "user-gran", createdBy: DEV_SESSION_IDS.userId });
    expect(memoryListPendingEnrollmentCodes(tenantId)).toHaveLength(1);

    bearer(redeemed.token);
    expect(await getSession({ scope: "device" })).toMatchObject({ userId: "user-gran", role: "member" });
    expect(memoryRemoveMember(tenantId, "user-gran").status).toBe("removed");
    expect(await getSession({ scope: "device" })).toBeNull();
    expect(memoryListPendingEnrollmentCodes(tenantId)).toHaveLength(0);
  });
});

describe("a full token", () => {
  function mintFull(): string {
    const minted = memoryCreateDesktopToken({ userId: DEV_SESSION_IDS.userId, tenantId: DEV_SESSION_IDS.tenantId, role: "owner", name: "Omarchy bar" });
    if ("error" in minted) throw new Error(minted.error);
    return minted.token;
  }

  it("resolves with scopes [full] and no device", async () => {
    bearer(mintFull());
    const s = await getSession();
    expect(s).toMatchObject({ ...DEV_SESSION_IDS, scopes: ["full"] });
    expect(s?.deviceId).toBeUndefined();
    // A full token does not hold `device`.
    expect(await getSession({ scope: "device" })).toBeNull();
    expect((await requireApiSession({ scope: "device" })).response?.status).toBe(403);
  });

  it("is never refused for scope on an existing route", async () => {
    const token = mintFull();
    const failures: string[] = [];
    for (const c of cases) {
      bearer(token);
      const res = await c.handler(requestFor(c.route, c.method), ctx());
      const body = (await res.clone().json().catch(() => ({}))) as { code?: string };
      if (res.status === 401 || body.code === "insufficient_scope") failures.push(`${c.method} /api/${c.route} → ${res.status} ${body.code ?? ""}`);
    }
    expect(failures).toEqual([]);
  });
});

describe("device signal routes", () => {
  // _specs/signals.md: /api/signals needs scope `signals:write` (not the default `full`), so a
  // monitoring token succeeds there and a full-scope token or browser session gets 403 — the
  // opposite of every other route (see the UNAUTHENTICATED comment above).
  it("a monitoring token (signals:write + device) is not refused on POST /api/signals or GET /api/signals/lists", async () => {
    const { token } = enrollMonitoringDevice();
    bearer(token);
    const postRes = await signalsPOST(post("/api/signals", { events: [] }));
    expect(postRes.status).not.toBe(403);
    bearer(token);
    const listsRes = await signalsListsGET(new Request("http://localhost/api/signals/lists"));
    expect(listsRes.status).not.toBe(403);
    expect(listsRes.status).not.toBe(401);
  });

  it("a device token without signals:write gets 403 insufficient_scope on POST /api/signals", async () => {
    const { deviceId } = enrollMonitoringDevice();
    const minted = memoryInsertDeviceToken({
      userId: DEV_SESSION_IDS.userId,
      tenantId: DEV_SESSION_IDS.tenantId,
      role: "owner",
      name: "Browser extension (device only)",
      deviceId,
      scopes: ["device"],
    });
    bearer(minted.token);
    const res = await signalsPOST(post("/api/signals", { events: [] }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "insufficient_scope" });
  });

  it("a full-scope token gets 403 insufficient_scope on POST /api/signals and GET /api/signals/lists", async () => {
    const minted = memoryCreateDesktopToken({ userId: DEV_SESSION_IDS.userId, tenantId: DEV_SESSION_IDS.tenantId, role: "owner", name: "Omarchy bar" });
    if ("error" in minted) throw new Error(minted.error);
    bearer(minted.token);
    const postRes = await signalsPOST(post("/api/signals", { events: [] }));
    expect(postRes.status).toBe(403);
    expect(await postRes.json()).toMatchObject({ code: "insufficient_scope" });
    bearer(minted.token);
    const listsRes = await signalsListsGET(new Request("http://localhost/api/signals/lists"));
    expect(listsRes.status).toBe(403);
    expect(await listsRes.json()).toMatchObject({ code: "insufficient_scope" });
  });

  it("a browser session gets 403 insufficient_scope on POST /api/signals (no deviceId)", async () => {
    authState.session = {
      userId: DEV_SESSION_IDS.userId,
      tenantId: DEV_SESSION_IDS.tenantId,
      role: "owner",
      user: { email: "pat@example.test", name: "Pat" },
      expires: "2099-01-01T00:00:00Z",
    };
    const res = await signalsPOST(post("/api/signals", { events: [] }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "insufficient_scope" });
  });

  // _specs/browser-extension.md: GET /api/signals/status needs the same signals:write scope
  // and is excluded from the generic walk by the same `signals(\/|$)` regex above.
  it("a monitoring token is not refused on GET /api/signals/status; a full token is", async () => {
    const { token } = enrollMonitoringDevice();
    bearer(token);
    const ok = await signalsStatusGET(new Request(`http://localhost/api/signals/status?ids=${crypto.randomUUID()}`));
    expect(ok.status).not.toBe(403);

    const minted = memoryCreateDesktopToken({ userId: DEV_SESSION_IDS.userId, tenantId: DEV_SESSION_IDS.tenantId, role: "owner", name: "Omarchy bar" });
    if ("error" in minted) throw new Error(minted.error);
    bearer(minted.token);
    const res = await signalsStatusGET(new Request(`http://localhost/api/signals/status?ids=${crypto.randomUUID()}`));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "insufficient_scope" });
  });
});

describe("device on-demand check route", () => {
  // _specs/browser-extension.md: POST /api/devices/check-url needs scope `url:check` (not the
  // default `full`); it is excluded from the generic walk by the `devices(\/|$)` regex above,
  // like every other /api/devices/* route.
  it("a monitoring token (url:check + device) is not refused", async () => {
    const { token } = enrollMonitoringDevice();
    bearer(token);
    const res = await checkUrlPOST(post("/api/devices/check-url", { url: "https://example.com/" }));
    expect(res.status).not.toBe(403);
  });

  it("a device token without url:check gets 403 insufficient_scope", async () => {
    const { deviceId } = enrollMonitoringDevice();
    const minted = memoryInsertDeviceToken({
      userId: DEV_SESSION_IDS.userId,
      tenantId: DEV_SESSION_IDS.tenantId,
      role: "owner",
      name: "Signals only",
      deviceId,
      scopes: ["device", "signals:write"],
    });
    bearer(minted.token);
    const res = await checkUrlPOST(post("/api/devices/check-url", { url: "https://example.com/" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "insufficient_scope" });
  });

  it("a full-scope token gets 403 insufficient_scope", async () => {
    const minted = memoryCreateDesktopToken({ userId: DEV_SESSION_IDS.userId, tenantId: DEV_SESSION_IDS.tenantId, role: "owner", name: "Omarchy bar" });
    if ("error" in minted) throw new Error(minted.error);
    bearer(minted.token);
    const res = await checkUrlPOST(post("/api/devices/check-url", { url: "https://example.com/" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "insufficient_scope" });
  });

  it("a browser session gets 403 insufficient_scope (no deviceId)", async () => {
    authState.session = {
      userId: DEV_SESSION_IDS.userId,
      tenantId: DEV_SESSION_IDS.tenantId,
      role: "owner",
      user: { email: "pat@example.test", name: "Pat" },
      expires: "2099-01-01T00:00:00Z",
    };
    const res = await checkUrlPOST(post("/api/devices/check-url", { url: "https://example.com/" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "insufficient_scope" });
  });
});

describe("browser sessions", () => {
  it("carry scopes [full]", async () => {
    authState.session = {
      userId: "u1",
      tenantId: "00000000-0000-4000-8000-000000000001",
      role: "member",
      user: { email: "a@example.test", name: "A" },
      expires: "2099-01-01T00:00:00Z",
    };
    expect(await getSession()).toMatchObject({ userId: "u1", scopes: ["full"] });
    vi.stubEnv("DEV_AUTH_BYPASS", "true");
    expect(await getSession()).toMatchObject({ ...DEV_SESSION_IDS, scopes: ["full"] });
  });
});
