// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { browser } from "wxt/browser";
import * as sync from "../lib/sync.js";
import { __resetStateChainForTests, getState, updateState } from "../lib/state.js";
import { MemoryBinStore, __setBinStoreForTests } from "../lib/policy/store.js";
import { encodeBin, prefixesFor } from "../../../scripts/category-lists/normalize.mjs";
import { __setPolicyKeysForTests } from "../lib/policy/keys.js";
import { destinationAfterApproval, parseBlockPageParams } from "../lib/blockPage.js";
import { makeBundle, makeKey, signEnvelope, type TestKey } from "./helpers/policy.js";
import type { PolicyEnvelope } from "@neo/verdict";

type Route = (url: URL, init: RequestInit) => { status: number; json?: unknown; etag?: string };
let calls: { path: string; method: string; body?: any }[];
let key: TestKey;

function installFetch(routes: Record<string, Route>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      calls.push({ path: url.pathname, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body as string) : undefined });
      const r = routes[url.pathname]?.(url, init) ?? { status: 404 };
      return new Response(r.json !== undefined ? JSON.stringify(r.json) : null, { status: r.status, headers: { "content-type": "application/json", ...(r.etag ? { etag: r.etag } : {}) } });
    }),
  );
}

async function storeBundle(bundle: ReturnType<typeof makeBundle>, extra: Record<string, unknown> = {}) {
  const envelope = (await signEnvelope(bundle, key)) as PolicyEnvelope;
  await updateState((s) => ({ ...s, policy: { envelope, etag: null, fetchedAt: Date.now() }, ...extra }));
}

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
  vi.unstubAllGlobals();
  __setBinStoreForTests(null);
});

describe("Ask to unblock", () => {
  it("posts unblock_site with the domain and the reason, and tracks the request for the 60 s poll", async () => {
    await storeBundle(makeBundle({ web: { block: ["games.example"] } }));
    installFetch({ "/api/devices/requests": () => ({ status: 201, json: { id: "r1", status: "pending", expiresAt: new Date(Date.now() + 3600_000).toISOString() } }) });
    const result = await sync.requestUnblock("games.example", "  for a school project  ");
    expect(result).toMatchObject({ ok: true, id: "r1", status: "pending" });
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({ kind: "unblock_site", detail: { domain: "games.example" }, reason: "for a school project" });
    expect((await getState()).trackedRequests.map((r) => r.id)).toEqual(["r1"]);
  });

  it("omits a blank reason, and refuses one over 140 characters without calling the server", async () => {
    await storeBundle(makeBundle({ web: { block: ["games.example"] } }));
    installFetch({ "/api/devices/requests": () => ({ status: 201, json: { id: "r1", status: "pending", expiresAt: new Date(Date.now() + 3600_000).toISOString() } }) });
    await sync.requestUnblock("games.example", "   ");
    expect(calls[0]!.body).toEqual({ kind: "unblock_site", detail: { domain: "games.example" } });
    calls = [];
    expect(await sync.requestUnblock("games.example", "x".repeat(141))).toEqual({ ok: false, error: "reason_too_long" });
    expect(calls).toEqual([]);
  });

  it("only asks for a domain the policy actually blocks (a web page cannot make it request anything)", async () => {
    await storeBundle(makeBundle({ web: { block: ["games.example"] } }));
    installFetch({});
    expect(await sync.requestUnblock("harmless.example", undefined)).toEqual({ ok: false, error: "not_blocked" });
    expect(calls).toEqual([]);
  });

  it("surfaces the server's limits", async () => {
    await storeBundle(makeBundle({ web: { block: ["games.example"] } }));
    installFetch({ "/api/devices/requests": () => ({ status: 429, json: { error: "x", code: "too_many_pending" } }) });
    expect(await sync.requestUnblock("games.example", undefined)).toEqual({ ok: false, error: "too_many_pending" });
  });
});

describe("request status and the reload", () => {
  const future = () => new Date(Date.now() + 3600_000).toISOString();

  it("stays blocked while pending", async () => {
    await storeBundle(makeBundle({ web: { block: ["games.example"] } }));
    await updateState((s) => ({ ...s, trackedRequests: [{ id: "r1", domain: "games.example", expiresAt: future() }] }));
    installFetch({ "/api/devices/requests/r1": () => ({ status: 200, json: { id: "r1", kind: "unblock_site", status: "pending", expiresAt: future() } }) });
    expect(await sync.getRequestStatus("r1", "games.example")).toEqual({ ok: true, status: "pending", blocked: true });
    expect((await getState()).trackedRequests).toHaveLength(1);
  });

  it("on approval fetches the new signed bundle and reports the domain as allowed", async () => {
    const before = makeBundle({ policyVersion: "1".repeat(64), web: { block: ["games.example"] } });
    const after = makeBundle({ policyVersion: "2".repeat(64), web: { block: ["games.example"], allow: ["games.example"] } });
    await storeBundle(before);
    await updateState((s) => ({ ...s, trackedRequests: [{ id: "r1", domain: "games.example", expiresAt: future() }] }));
    const signed = await signEnvelope(after, key);
    installFetch({
      "/api/devices/requests/r1": () => ({ status: 200, json: { id: "r1", kind: "unblock_site", status: "approved", expiresAt: future() } }),
      "/api/devices/policy": () => ({ status: 200, json: signed, etag: '"v2"' }),
    });
    const result = await sync.getRequestStatus("r1", "games.example");
    expect(result).toEqual({ ok: true, status: "approved", blocked: false });
    expect((await getState()).policy?.envelope.bundle.policyVersion).toBe("2".repeat(64));
    expect((await getState()).trackedRequests).toEqual([]); // no longer polling
  });

  it("approved but the new bundle has not arrived: keeps tracking, and later polls do not fetch the bundle again", async () => {
    await storeBundle(makeBundle({ web: { block: ["games.example"] } }));
    await updateState((s) => ({ ...s, trackedRequests: [{ id: "r1", domain: "games.example", expiresAt: future() }] }));
    installFetch({ "/api/devices/requests/r1": () => ({ status: 200, json: { id: "r1", kind: "unblock_site", status: "approved", expiresAt: future() } }), "/api/devices/policy": () => ({ status: 304 }) });
    expect(await sync.getRequestStatus("r1", "games.example")).toEqual({ ok: true, status: "approved", blocked: true });
    expect((await getState()).trackedRequests).toMatchObject([{ id: "r1", settled: true }]);
    await sync.getRequestStatus("r1", "games.example");
    await sync.getRequestStatus("r1", "games.example");
    expect(calls.filter((c) => c.path === "/api/devices/policy")).toHaveLength(1);
  });

  it("denied: no reload, tracking stops", async () => {
    await storeBundle(makeBundle({ web: { block: ["games.example"] } }));
    await updateState((s) => ({ ...s, trackedRequests: [{ id: "r1", domain: "games.example", expiresAt: future() }] }));
    installFetch({ "/api/devices/requests/r1": () => ({ status: 200, json: { id: "r1", kind: "unblock_site", status: "denied", expiresAt: future() } }), "/api/devices/policy": () => ({ status: 304 }) });
    expect(await sync.getRequestStatus("r1", "games.example")).toEqual({ ok: true, status: "denied", blocked: true });
    expect((await getState()).trackedRequests).toEqual([]);
  });

  it("drops a tracked request that has expired", async () => {
    await updateState((s) => ({ ...s, trackedRequests: [{ id: "old", domain: "games.example", expiresAt: new Date(Date.now() - 1000).toISOString() }] }));
    const policy = await import("../lib/policy/sync.js");
    expect(await policy.pendingRequests(Date.now())).toEqual([]);
    expect((await getState()).trackedRequests).toEqual([]);
  });
});

describe("block page shown", () => {
  it("reports web_blocked once for a category hit, using only the registrable domain and category", async () => {
    const bin = encodeBin(prefixesFor(["porn.example"]));
    const bytes = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer;
    const sha = "ab".repeat(32);
    const store = new MemoryBinStore();
    __setBinStoreForTests(store);
    await store.put(sha, bytes);
    await storeBundle(makeBundle({ web: { categories: ["adult"] } }), { categoryData: { version: "c1", shas: { adult: sha } } });
    installFetch({ "/api/signals": () => ({ status: 200, json: { results: [{ id: "x", status: "accepted" }] } }) });
    const info = await sync.handleBlockPageShown("porn.example");
    expect(info).toMatchObject({ blocked: true, category: "adult" });
    await sync.handleBlockPageShown("porn.example");
    const queued = (await getState()).queue.map((q) => q.event).concat();
    const posted = calls.filter((c) => c.path === "/api/signals").flatMap((c) => c.body.events);
    const events = [...queued, ...posted].filter((e: any) => e.detector === "web_blocked");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "page", detector: "web_blocked", domain: "porn.example", category: "adult" });
    expect(Object.keys(events[0]).sort()).toEqual(["category", "detector", "domain", "id", "observedAt", "type"]);
  });

  it("a well-known domain is blocked before the category files have downloaded (no redirect loop with its DNR rule)", async () => {
    await storeBundle(makeBundle({ web: { categories: ["adult"] } }), { categoryData: null });
    expect(await sync.handleBlockPageShown("pornhub.com")).toMatchObject({ blocked: true, category: "adult" });
  });

  it("says not blocked for a forged URL, and reports nothing", async () => {
    await storeBundle(makeBundle({ web: { block: ["games.example"] } }));
    expect(await sync.handleBlockPageShown("harmless.example")).toEqual({ blocked: false, category: null });
    expect((await getState()).queue).toEqual([]);
  });

  it("does not report the parent's own block list (no category to send)", async () => {
    await storeBundle(makeBundle({ web: { block: ["games.example"] } }));
    expect(await sync.handleBlockPageShown("games.example")).toMatchObject({ blocked: true, category: null });
    expect((await getState()).queue).toEqual([]);
  });
});

describe("check-host (content-script path)", () => {
  it("sends the tab to the block page with the original URL", async () => {
    await storeBundle(makeBundle({ web: { block: ["games.example"] } }));
    const update = vi.spyOn(browser.tabs, "update").mockResolvedValue({} as any);
    const r = await sync.handleCheckHost("www.games.example", "https://www.games.example/play?x=1", 7);
    expect(r).toEqual({ blocked: true });
    const url = String(update.mock.calls[0]![1]!.url);
    expect(update.mock.calls[0]![0]).toBe(7);
    expect(url).toContain("/blocked.html?d=games.example&c=custom&u=");
    // The block page parses what the redirect built.
    const params = parseBlockPageParams(new URL(url).search)!;
    expect(params).toMatchObject({ domain: "games.example", category: "custom", returnUrl: "https://www.games.example/play?x=1" });
  });
  it("does nothing for an allowed host, or outside Child mode", async () => {
    await storeBundle(makeBundle({ web: { block: ["games.example"], allow: ["games.example"] } }));
    const update = vi.spyOn(browser.tabs, "update").mockResolvedValue({} as any);
    expect(await sync.handleCheckHost("games.example", "https://games.example/", 7)).toEqual({ blocked: false });
    await storeBundle(makeBundle({ mode: "standard", web: { block: ["games.example"] } }));
    expect(await sync.handleCheckHost("games.example", "https://games.example/", 7)).toEqual({ blocked: false });
    expect(update).not.toHaveBeenCalled();
  });
});

describe("block page URL parsing", () => {
  it("validates the domain, the category and the return URL", () => {
    expect(parseBlockPageParams("?d=Games.Example&c=adult")).toEqual({ domain: "games.example", category: "adult", returnUrl: null });
    expect(parseBlockPageParams("?d=games.example&c=nonsense")?.category).toBe("custom");
    expect(parseBlockPageParams("?d=not a domain")).toBeNull();
    expect(parseBlockPageParams("")).toBeNull();
    expect(parseBlockPageParams("?d=games.example&u=javascript:alert(1)")?.returnUrl).toBeNull();
    expect(parseBlockPageParams(`?d=games.example&u=${encodeURIComponent("https://evil.example/")}`)?.returnUrl).toBeNull();
    expect(parseBlockPageParams(`?d=games.example&u=${encodeURIComponent("https://games.example.evil.example/")}`)?.returnUrl).toBeNull();
  });
  it("goes back to the page that was blocked, else the front page", () => {
    expect(destinationAfterApproval({ domain: "a.example", category: "custom", returnUrl: "https://a.example/x" })).toBe("https://a.example/x");
    expect(destinationAfterApproval({ domain: "a.example", category: "custom", returnUrl: null })).toBe("https://a.example/");
  });
});
