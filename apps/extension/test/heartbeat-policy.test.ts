// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { browser } from "wxt/browser";
import * as sync from "../lib/sync.js";
import { __resetStateChainForTests, getState, updateState } from "../lib/state.js";
import { MemoryBinStore, __setBinStoreForTests } from "../lib/policy/store.js";
import { __setPolicyKeysForTests } from "../lib/policy/keys.js";
import { makeBundle, makeKey, signEnvelope, type TestKey } from "./helpers/policy.js";

let key: TestKey;
let calls: { path: string; method: string; body?: any; headers: Record<string, string> }[];

function installFetch(routes: Record<string, () => { status: number; json?: unknown; etag?: string }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      calls.push({ path: url.pathname, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body as string) : undefined, headers: (init.headers ?? {}) as Record<string, string> });
      const r = routes[url.pathname]?.() ?? { status: 404 };
      return new Response(r.json !== undefined ? JSON.stringify(r.json) : null, { status: r.status, headers: { "content-type": "application/json", ...(r.etag ? { etag: r.etag } : {}) } });
    }),
  );
}

const hb = (policyVersion: string | null | undefined) => () => ({
  status: 200,
  json: { device: { id: "d1", userId: null, memberName: "Sam", status: "active" }, householdName: "H", memberName: "Sam", heartbeatSeconds: 3600, listsVersion: "L1", ...(policyVersion === undefined ? {} : { policyVersion }) },
});
const lists = () => ({ status: 200, json: { version: "L1", remoteAccessTools: [], pupPublishers: [], scamPagePhrases: [], skipDomains: [], brands: [] }, etag: '"L1"' });

beforeEach(async () => {
  fakeBrowser.reset();
  __resetStateChainForTests();
  __setBinStoreForTests(new MemoryBinStore());
  calls = [];
  key = await makeKey("k1");
  __setPolicyKeysForTests([key.publicJwk]);
  vi.spyOn(browser.declarativeNetRequest, "getDynamicRules").mockImplementation((async () => []) as any);
  vi.spyOn(browser.declarativeNetRequest, "updateDynamicRules").mockImplementation((async () => undefined) as any);
  vi.spyOn(browser.runtime, "getManifest").mockReturnValue({ manifest_version: 3, name: "Neo", version: "0.0.0-test" } as any);
  await updateState((s) => ({ ...s, connection: "enrolled", token: "neo_dt_x", deviceId: "d1", serverUrl: "https://neo.test" }));
});
afterEach(() => {
  __setPolicyKeysForTests(null);
  __setBinStoreForTests(null);
  vi.unstubAllGlobals();
});

describe("heartbeat and policy", () => {
  it("fetches the policy when the server's version differs, then reports the applied version on the next heartbeat", async () => {
    const bundle = makeBundle({ policyVersion: "b".repeat(64), web: { block: ["games.example"] } });
    const signed = await signEnvelope(bundle, key);
    installFetch({ "/api/devices/heartbeat": hb(bundle.policyVersion), "/api/signals/lists": lists, "/api/devices/policy": () => ({ status: 200, json: signed, etag: `"${bundle.policyVersion}"` }) });
    await sync.runHeartbeat();
    expect(calls.some((c) => c.path === "/api/devices/policy")).toBe(true);
    expect(calls.find((c) => c.path === "/api/devices/heartbeat")!.body).toEqual({ clientVersion: "0.0.0-test" });
    expect((await getState()).policyApplied).toBe(bundle.policyVersion);

    calls = [];
    await sync.runHeartbeat();
    expect(calls.find((c) => c.path === "/api/devices/heartbeat")!.body).toEqual({ clientVersion: "0.0.0-test", policyVersion: bundle.policyVersion });
    expect(calls.some((c) => c.path === "/api/devices/policy")).toBe(false); // same version: nothing to fetch
  });

  it("does not touch the policy route for an older server that sends no policyVersion", async () => {
    installFetch({ "/api/devices/heartbeat": hb(undefined), "/api/signals/lists": lists });
    await sync.runHeartbeat();
    expect(calls.some((c) => c.path === "/api/devices/policy")).toBe(false);
  });

  it("polls the policy every tick while a request is pending, and not otherwise", async () => {
    const bundle = makeBundle({ policyVersion: "c".repeat(64), web: { block: ["games.example"] } });
    const signed = await signEnvelope(bundle, key);
    installFetch({ "/api/devices/policy": () => ({ status: 200, json: signed, etag: '"c"' }), "/api/signals": () => ({ status: 200, json: { results: [] } }) });
    await sync.handleAlarm("neo-tick");
    expect(calls.some((c) => c.path === "/api/devices/policy")).toBe(false);

    await updateState((s) => ({ ...s, trackedRequests: [{ id: "r1", domain: "games.example", expiresAt: new Date(Date.now() + 3600_000).toISOString() }] }));
    await sync.handleAlarm("neo-tick");
    expect(calls.filter((c) => c.path === "/api/devices/policy")).toHaveLength(1);
    expect((await getState()).policy?.envelope.bundle.policyVersion).toBe(bundle.policyVersion);
  });
});
