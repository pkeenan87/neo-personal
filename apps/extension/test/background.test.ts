import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { browser } from "wxt/browser";
import * as sync from "../lib/sync.js";
import { __resetStateChainForTests, getState, updateState } from "../lib/state.js";
import * as q from "../lib/queue.js";
import type { SignalEvent } from "@neo/verdict";

type MockResponse = { status: number; json?: unknown; headers?: Record<string, string> };
type Handler = (url: URL, init: RequestInit) => MockResponse | Promise<MockResponse>;

/** Routes the mocked `fetch` by pathname; an unmatched path gets a harmless 200 `{}`. */
function installFetchMock(routes: Record<string, Handler>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      const handler = routes[url.pathname];
      const r = handler ? await handler(url, init) : { status: 200, json: {} };
      return new Response(r.json !== undefined ? JSON.stringify(r.json) : null, {
        status: r.status,
        headers: { "content-type": "application/json", ...(r.headers ?? {}) },
      });
    }),
  );
}

function requestBody(init: RequestInit): any {
  return JSON.parse(init.body as string);
}

beforeEach(() => {
  fakeBrowser.reset();
  __resetStateChainForTests();
  // fakeBrowser doesn't implement getManifest (`@webext-core/fake-browser`); `clientVersion()`
  // (`lib/platform.ts`) needs it for every device-identifying call (enroll, sign-in, heartbeat).
  vi.spyOn(browser.runtime, "getManifest").mockReturnValue({ manifest_version: 3, name: "Neo", version: "0.0.0-test" } as any);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("enrollment", () => {
  it("enrolls by code, then heartbeats and fetches lists", async () => {
    installFetchMock({
      "/api/devices/enroll": () => ({
        status: 201,
        json: {
          token: "neo_dt_abc",
          tokenId: "t1",
          device: { id: "d1", userId: "u1", memberName: "Alex", status: "active" },
          householdName: "The Smiths",
          memberName: "Alex",
        },
      }),
      "/api/devices/heartbeat": () => ({
        status: 200,
        json: {
          device: { id: "d1", userId: "u1", memberName: "Alex", status: "active" },
          householdName: "The Smiths",
          memberName: "Alex",
          heartbeatSeconds: 3600,
          listsVersion: "v1",
          uninstallUrl: "https://www.neoshield.dev/uninstalled?d=d1&s=sig",
        },
      }),
      "/api/signals/lists": () => ({ status: 200, json: { version: "v1", remoteAccessTools: [], pupPublishers: [], scamPagePhrases: [], skipDomains: [], brands: [] } }),
    });

    const result = await sync.enrollWithCode("ABCD-1234", "My Chrome");
    expect(result.ok).toBe(true);

    const state = await getState();
    expect(state.connection).toBe("enrolled");
    expect(state.token).toBe("neo_dt_abc");
    expect(state.deviceId).toBe("d1");
    expect(state.household).toEqual({ householdName: "The Smiths", memberName: "Alex", ownerName: null });
    expect(state.listsVersion).toBe("v1");
    expect(state.uninstallUrl).toBe("https://www.neoshield.dev/uninstalled?d=d1&s=sig");
  });

  it("self-enrolls through the device-authorization flow (pending, then approved)", async () => {
    let pollCount = 0;
    installFetchMock({
      "/api/desktop/device": () => ({
        status: 201,
        json: { deviceCode: "dc1", userCode: "ABCD-1234", verificationUri: "https://www.neoshield.dev/desktop/authorize", verificationUriComplete: "https://www.neoshield.dev/desktop/authorize?code=ABCD-1234", expiresIn: 600, interval: 5 },
      }),
      "/api/desktop/device/token": () => {
        pollCount += 1;
        if (pollCount === 1) return { status: 202, json: { status: "pending", interval: 5 } };
        return {
          status: 200,
          json: { status: "approved", token: "neo_dt_xyz", tokenId: "t2", clientName: "Neo", email: null, name: null, scopes: ["device", "signals:write", "url:check"], device: { id: "d2", userId: "u1", memberName: null, status: "active" } },
        };
      },
      "/api/devices/heartbeat": () => ({
        status: 200,
        json: { device: { id: "d2", userId: "u1", memberName: null, status: "active" }, householdName: "The Smiths", memberName: null, heartbeatSeconds: 3600, listsVersion: "v1" },
      }),
      "/api/signals/lists": () => ({ status: 200, json: { version: "v1", remoteAccessTools: [], pupPublishers: [], scamPagePhrases: [], skipDomains: [], brands: [] } }),
    });

    const started = await sync.startSignIn("My Firefox");
    expect(started.ok).toBe(true);
    expect((await getState()).connection).toBe("enrolling");

    expect(await sync.pollSignIn()).toBe("pending");
    expect((await getState()).connection).toBe("enrolling");

    expect(await sync.pollSignIn()).toBe("approved");
    const state = await getState();
    expect(state.connection).toBe("enrolled");
    expect(state.token).toBe("neo_dt_xyz");
    expect(state.deviceId).toBe("d2");
  });
});

describe("heartbeat", () => {
  async function enroll(initialListsVersion: string | null): Promise<void> {
    await updateState((s) => ({ ...s, connection: "enrolled", token: "neo_dt_abc", deviceId: "d1", listsVersion: initialListsVersion }));
  }

  it("sets the uninstall URL and refetches lists only when the version changed", async () => {
    await enroll("v1");
    let listsFetches = 0;
    installFetchMock({
      "/api/devices/heartbeat": () => ({
        status: 200,
        json: { device: { id: "d1" }, householdName: "The Smiths", memberName: "Alex", heartbeatSeconds: 3600, listsVersion: "v2", uninstallUrl: "https://www.neoshield.dev/uninstalled?d=d1&s=sig" },
      }),
      "/api/signals/lists": () => {
        listsFetches += 1;
        return { status: 200, json: { version: "v2", remoteAccessTools: [], pupPublishers: [], scamPagePhrases: [], skipDomains: [], brands: [] } };
      },
    });
    const setUninstallSpy = vi.spyOn(browser.runtime, "setUninstallURL").mockResolvedValue();

    await sync.runHeartbeat();

    expect(setUninstallSpy).toHaveBeenCalledWith("https://www.neoshield.dev/uninstalled?d=d1&s=sig");
    expect(listsFetches).toBe(1);
    expect((await getState()).listsVersion).toBe("v2");
  });

  it("does not refetch lists when the version is unchanged", async () => {
    await enroll("v1");
    let listsFetches = 0;
    installFetchMock({
      "/api/devices/heartbeat": () => ({ status: 200, json: { device: { id: "d1" }, householdName: "The Smiths", memberName: "Alex", heartbeatSeconds: 3600, listsVersion: "v1" } }),
      "/api/signals/lists": () => {
        listsFetches += 1;
        return { status: 200, json: {} };
      },
    });
    await sync.runHeartbeat();
    expect(listsFetches).toBe(0);
  });

  it("401 disconnects the extension", async () => {
    await enroll("v1");
    installFetchMock({ "/api/devices/heartbeat": () => ({ status: 401, json: { error: "revoked", code: "unauthenticated" } }) });
    await sync.runHeartbeat();
    const state = await getState();
    expect(state.connection).toBe("disconnected");
    expect(state.token).toBeNull();
  });
});

describe("event queue: backoff and stale drop (pure logic)", () => {
  const event: SignalEvent = { id: "11111111-1111-1111-1111-111111111111", type: "page", detector: "tech_support_scam", observedAt: new Date(0).toISOString(), domain: "example.com", indicators: ["fake_scan", "fullscreen"] };

  it("backs off with Retry-After after a failed send, and allows a flush again once it elapses", () => {
    const base = { connection: "enrolled" as const, queue: [{ event, queuedAt: 0, attempts: 0 }] };
    let state = { ...q.dropStaleEvents({ ...emptyState(), ...base }, 0) };
    state = q.applySendFailure(state, state.queue, 1000, 30);
    expect(q.canFlushNow(state, 1000)).toBe(false);
    expect(q.canFlushNow(state, 1000 + 30_000)).toBe(true);
    expect(state.queue[0]!.attempts).toBe(1);
  });

  it("drops events queued more than 23h ago", () => {
    const oldQueued = { event, queuedAt: 0, attempts: 0 };
    const state = { ...emptyState(), queue: [oldQueued] };
    const now = 24 * 60 * 60 * 1000; // 24h later
    const dropped = q.dropStaleEvents(state, now);
    expect(dropped.queue).toHaveLength(0);
  });

  it("keeps events queued less than 23h ago", () => {
    const recent = { event, queuedAt: 0, attempts: 0 };
    const state = { ...emptyState(), queue: [recent] };
    const dropped = q.dropStaleEvents(state, 60_000);
    expect(dropped.queue).toHaveLength(1);
  });
});

describe("local dedupe", () => {
  it("sends at most one event per (detector, domain) per hour", async () => {
    await updateState((s) => ({ ...s, connection: "enrolled", token: "neo_dt_abc", deviceId: "d1" }));
    installFetchMock({ "/api/signals": () => ({ status: 200, json: { results: [{ id: "x", status: "accepted" }] } }) });

    await sync.reportTechSupportHit({ domain: "scam.example", pageUrl: "https://scam.example/", indicators: ["fake_scan", "fullscreen"] }, 1);
    await sync.reportTechSupportHit({ domain: "scam.example", pageUrl: "https://scam.example/", indicators: ["fake_scan", "fullscreen"] }, 1);

    const state = await getState();
    expect(state.queue.length + state.warnings.length).toBeGreaterThan(0);
    // Exactly one warning was ever shown for this domain, whatever the queue's current length
    // (the second report is deduped before it ever reaches the queue or shows a warning).
    expect(state.warnings.filter((w) => w.domain === "scam.example")).toHaveLength(1);
  });
});

describe("pending polling", () => {
  async function enroll(): Promise<void> {
    await updateState((s) => ({ ...s, connection: "enrolled", token: "neo_dt_abc", deviceId: "d1" }));
  }

  async function forcePollNow(): Promise<void> {
    await updateState((s) => ({ ...s, pending: s.pending.map((p) => ({ ...p, nextPollAt: 0 })) }));
  }

  it("shows the warning once the server confirms it", async () => {
    await enroll();
    let statusCall = 0;
    installFetchMock({
      "/api/signals": (_url, init) => {
        const id = requestBody(init).events[0].id;
        return { status: 200, json: { results: [{ id, status: "accepted", pending: true }] } };
      },
      "/api/signals/status": (url) => {
        statusCall += 1;
        const ids = (url.searchParams.get("ids") ?? "").split(",");
        const outcome = statusCall === 1 ? "pending" : "alerted";
        return { status: 200, json: { results: ids.map((id) => ({ id, outcome, alerted: outcome === "alerted" })) } };
      },
    });

    await sync.reportLookalikeHit({ domain: "paypa1-secure.example", pageUrl: "https://paypa1-secure.example/login", brand: "paypal", indicators: ["password_field", "lookalike_skeleton"] }, 7);
    await sync.flushQueue();
    expect((await getState()).pending).toHaveLength(1);

    await forcePollNow();
    await sync.pumpPending();
    expect((await getState()).warnings).toHaveLength(0); // still pending after the first poll

    await forcePollNow();
    await sync.pumpPending();
    const state = await getState();
    expect(state.pending).toHaveLength(0);
    expect(state.warnings).toHaveLength(1);
    expect(state.warnings[0]!.domain).toBe("paypa1-secure.example");
  });

  it("shows nothing when the server dismisses it", async () => {
    await enroll();
    installFetchMock({
      "/api/signals": (_url, init) => {
        const id = requestBody(init).events[0].id;
        return { status: 200, json: { results: [{ id, status: "accepted", pending: true }] } };
      },
      "/api/signals/status": (url) => {
        const ids = (url.searchParams.get("ids") ?? "").split(",");
        return { status: 200, json: { results: ids.map((id) => ({ id, outcome: "dismissed", alerted: false })) } };
      },
    });

    await sync.reportLookalikeHit({ domain: "safe-lookalike.example", pageUrl: "https://safe-lookalike.example/login", brand: "paypal", indicators: ["password_field", "lookalike_skeleton"] }, 7);
    await sync.flushQueue();
    await forcePollNow();
    await sync.pumpPending();

    const state = await getState();
    expect(state.pending).toHaveLength(0);
    expect(state.warnings).toHaveLength(0);
  });
});

function emptyState() {
  return {
    connection: "enrolled" as const,
    serverUrl: null,
    token: "neo_dt_abc",
    deviceId: "d1",
    device: null,
    household: null,
    lastHeartbeatAt: null,
    heartbeatSeconds: 3600,
    listsVersion: null,
    lists: null,
    listsEtag: null,
    listsIsSnapshot: true,
    queue: [],
    queueNextAttemptAt: null,
    queueAttempt: 0,
    pending: [],
    dedupe: {},
    suppressUntil: {},
    warnings: [],
    uninstallUrl: null,
    signIn: null,
  };
}
