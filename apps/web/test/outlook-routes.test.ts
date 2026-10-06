// @vitest-environment node
import type { Session } from "next-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as callback } from "@/app/api/connectors/outlook/callback/route";
import { DELETE, GET } from "@/app/api/connectors/outlook/route";
import { POST as start } from "@/app/api/connectors/outlook/start/route";
import { memoryCreateDesktopToken } from "@/lib/server/memory-desktop-tokens";
import { memoryState, setMemoryMembers } from "@/lib/server/memory-state";
import { resetMemoryAlerts } from "@/lib/server/memory-alerts";
import { resetMemoryState, stubBaseEnv } from "./helpers/routes";

const authState = vi.hoisted(() => ({ session: null as Session | null }));
const hdrs = vi.hoisted(() => ({ current: new Headers() }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => authState.session) }));
vi.mock("next/headers", () => ({ headers: async () => hdrs.current, cookies: async () => ({ get: () => undefined, getAll: () => [] }) }));

const TENANT = "00000000-0000-4000-8000-0000000000ee";
const ORIGIN = "http://localhost";
const APP = "http://localhost:3000"; // APP_URL default: redirects never derive from the request URL
const req = (path: string, init: RequestInit = {}) => new Request(`${ORIGIN}${path}`, init);
function signIn(userId: string, role: "owner" | "member"): void {
  authState.session = { userId, tenantId: TENANT, role, user: { email: `${userId}@example.test`, name: userId }, expires: "2099-01-01T00:00:00Z" };
}

beforeEach(() => {
  stubBaseEnv(vi);
  vi.stubEnv("DEV_AUTH_BYPASS", "false");
  resetMemoryState();
  resetMemoryAlerts();
  hdrs.current = new Headers();
  setMemoryMembers(TENANT, [{ userId: "o", name: "o", email: "o@example.test", role: "owner" }, { userId: "m", name: "m", email: "m@example.test", role: "member" }]);
  signIn("m", "member");
});
afterEach(() => vi.unstubAllEnvs());

const post = (path: string) => start(req(path, { method: "POST", headers: { Origin: ORIGIN } }));

describe("Outlook connector routes", () => {
  it("mock-mode end to end: start, local authorize, callback, status, disconnect", async () => {
    const s = await post("/api/connectors/outlook/start");
    expect(s.status).toBe(200);
    const { authorizeUrl } = (await s.json()) as { authorizeUrl: string };
    const u = new URL(authorizeUrl);
    const cb = await callback(req(`/api/connectors/outlook/callback${u.search}`));
    expect(cb.status).toBe(303);
    expect(cb.headers.get("Location")).toBe(`${APP}/settings/outlook?connect=connected`);
    const view = (await (await GET()).json()) as { mode: string; connector: { status: string } | null; findings: unknown[] };
    expect(view).toMatchObject({ mode: "mock", connector: { status: "connected" } });
    expect(view.findings.length).toBeGreaterThan(0);

    expect((await DELETE(req("/api/connectors/outlook", { method: "DELETE" }))).status).toBe(403); // no Origin
    expect((await DELETE(req("/api/connectors/outlook", { method: "DELETE", headers: { Origin: "https://evil.example" } }))).status).toBe(403);
    expect(memoryState().outlook.connectors[0]!.status).toBe("connected");
    const del = await DELETE(req("/api/connectors/outlook", { method: "DELETE", headers: { Origin: ORIGIN } }));
    expect(del.status).toBe(200);
    expect(await del.json()).toMatchObject({ ok: true, appAccessUrl: "https://account.microsoft.com/privacy/app-access" });
    expect(memoryState().outlook.connectors[0]).toMatchObject({ status: "disconnected" });
  });
  it("callback handles access_denied with a fixed redirect and never echoes error_description", async () => {
    const { authorizeUrl } = (await (await post("/api/connectors/outlook/start")).json()) as { authorizeUrl: string };
    const state = new URL(authorizeUrl).searchParams.get("state")!;
    const cb = await callback(req(`/api/connectors/outlook/callback?error=access_denied&error_description=SECRET&state=${state}`));
    expect(cb.headers.get("Location")).toBe(`${APP}/settings/outlook?connect=denied`);
    expect(cb.headers.get("Location")).not.toContain("SECRET");
    const again = await callback(req(`/api/connectors/outlook/callback?code=mock-x&state=${state}`));
    expect(again.headers.get("Location")).toContain("connect=invalid_state");
  });
  it("a callback by a different signed-in user is rejected and does not consume the state", async () => {
    const { authorizeUrl } = (await (await post("/api/connectors/outlook/start")).json()) as { authorizeUrl: string };
    const u = new URL(authorizeUrl);
    signIn("o", "owner"); // another member of the same household
    const wrong = await callback(req(`/api/connectors/outlook/callback${u.search}`));
    expect(wrong.headers.get("Location")).toBe(`${APP}/settings/outlook?connect=invalid_state`);
    expect(memoryState().outlook.connectors).toEqual([]);
    expect(memoryState().outlook.states.map((x) => x.consumedAt)).toEqual([undefined]); // still unconsumed
    signIn("m", "member");
    const right = await callback(req(`/api/connectors/outlook/callback${u.search}`));
    expect(right.headers.get("Location")).toBe(`${APP}/settings/outlook?connect=connected`);
  });
  it("callback redirects use APP_URL, never the request URL", async () => {
    vi.stubEnv("AUTH_URL", "https://app.example.test/");
    const res = await callback(new Request("https://evil.example/api/connectors/outlook/callback?error=access_denied&state=x", { headers: { Host: "evil.example" } }));
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("https://app.example.test/settings/outlook?connect=invalid_state");
  });
  it("needs a browser session: no session is 401, a desktop token is 403", async () => {
    authState.session = null;
    expect((await post("/api/connectors/outlook/start")).status).toBe(401);
    expect((await callback(req("/api/connectors/outlook/callback"))).status).toBe(401);
    signIn("m", "member");
    const t = memoryCreateDesktopToken({ tenantId: TENANT, userId: "m", role: "member", name: "laptop" });
    hdrs.current = new Headers({ authorization: `Bearer ${(t as { token: string }).token}` });
    authState.session = null;
    expect((await post("/api/connectors/outlook/start")).status).toBe(403);
  });
  it("is off without configuration: start 503, callback 404, status reports mode off, disconnect still works", async () => {
    vi.stubEnv("MOCK_MODE", "false");
    vi.stubEnv("OUTLOOK_CLIENT_ID", "id");
    vi.stubEnv("OUTLOOK_CLIENT_SECRET", "");
    vi.stubEnv("OUTLOOK_REDIRECT_URI", "https://x.test/cb");
    expect((await post("/api/connectors/outlook/start")).status).toBe(503);
    expect((await callback(req("/api/connectors/outlook/callback?code=a&state=b"))).status).toBe(404);
    expect(await (await GET()).json()).toMatchObject({ mode: "off", connector: null });
    expect((await DELETE(req("/api/connectors/outlook", { method: "DELETE", headers: { Origin: ORIGIN } }))).status).toBe(200);
  });
  it("start rejects a cross-origin request", async () => {
    expect((await start(req("/api/connectors/outlook/start", { method: "POST", headers: { Origin: "https://evil.example" } }))).status).toBe(403);
  });
});
