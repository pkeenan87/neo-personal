// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import type { SignalEvent } from "@neo/verdict";
import { __resetStateChainForTests, getState, updateState } from "../lib/state.js";
import { applyStoredPolicy, syncPolicy, type DnrApi, type PolicyContext } from "../lib/policy/sync.js";
import { MemoryBinStore } from "../lib/policy/store.js";
import { parsePolicyKeys } from "../lib/policy/keys.js";
import { makeBundle, makeKey, signEnvelope, type TestKey } from "./helpers/policy.js";

let key: TestKey;
let otherKey: TestKey;
let reported: SignalEvent[];
let dnrCalls: { removeRuleIds: number[]; addRules: { id: number }[] }[];
let ctx: PolicyContext;
let requests: { headers: Record<string, string> }[];

const dnr: DnrApi = {
  getDynamicRules: async () => [{ id: 1 }, { id: 2 }],
  updateDynamicRules: async (o) => {
    dnrCalls.push(o);
  },
};

function mockPolicyResponse(responses: { status: number; json?: unknown; etag?: string }[]) {
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit = {}) => {
      requests.push({ headers: (init.headers ?? {}) as Record<string, string> });
      const r = responses[Math.min(i++, responses.length - 1)]!;
      return new Response(r.json !== undefined ? JSON.stringify(r.json) : null, {
        status: r.status,
        headers: { "content-type": "application/json", ...(r.etag ? { etag: r.etag } : {}) },
      });
    }),
  );
}

beforeEach(async () => {
  fakeBrowser.reset();
  __resetStateChainForTests();
  key = await makeKey("k1");
  otherKey = await makeKey("k2");
  reported = [];
  dnrCalls = [];
  requests = [];
  await updateState((s) => ({ ...s, connection: "enrolled", token: "neo_dt_x", deviceId: "d1", serverUrl: "https://neo.test" }));
  ctx = {
    serverUrl: "https://neo.test",
    token: "neo_dt_x",
    report: async (e) => {
      reported.push(e);
      return true;
    },
    keys: [key.publicJwk],
    store: new MemoryBinStore(),
    dnr,
  };
});

afterEach(() => vi.unstubAllGlobals());

describe("policy envelope verification", () => {
  it("accepts a correctly signed bundle, stores it and installs rules for it", async () => {
    const bundle = makeBundle({ web: { safeSearch: true, block: ["bad.example"] } });
    mockPolicyResponse([{ status: 200, json: await signEnvelope(bundle, key), etag: `"${bundle.policyVersion}"` }]);
    expect(await syncPolicy(ctx)).toBe("updated");
    const state = await getState();
    expect(state.policy?.envelope.bundle.policyVersion).toBe(bundle.policyVersion);
    expect(state.policy?.etag).toBe(`"${bundle.policyVersion}"`);
    expect(state.policyApplied).toBe(bundle.policyVersion);
    expect(dnrCalls).toHaveLength(1);
    expect(dnrCalls[0]!.removeRuleIds).toEqual([1, 2]); // every existing dynamic rule is replaced
    expect(dnrCalls[0]!.addRules.length).toBeGreaterThan(0);
    expect(reported).toEqual([]);
  });

  it("rejects a tampered bundle, keeps the last valid one, and reports bad_policy_signature", async () => {
    const good = makeBundle({ policyVersion: "1".repeat(64), web: { block: ["old.example"] } });
    mockPolicyResponse([{ status: 200, json: await signEnvelope(good, key), etag: '"v1"' }]);
    await syncPolicy(ctx);

    const next = makeBundle({ policyVersion: "2".repeat(64), web: { block: [] } });
    const envelope = await signEnvelope(next, key);
    // An attacker lifts the block list after signing.
    const tampered = { ...envelope, bundle: { ...(envelope.bundle as object), mode: "standard" } };
    mockPolicyResponse([{ status: 200, json: tampered }]);
    dnrCalls = [];
    expect(await syncPolicy(ctx)).toBe("rejected");

    const state = await getState();
    expect(state.policy?.envelope.bundle.policyVersion).toBe("1".repeat(64));
    expect(state.policy?.envelope.bundle.mode).toBe("child");
    expect(dnrCalls).toEqual([]);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ detector: "tamper_detected", type: "tamper", reason: "bad_policy_signature" });
  });

  it("rejects a bundle signed by an unknown key id", async () => {
    mockPolicyResponse([{ status: 200, json: await signEnvelope(makeBundle(), otherKey) }]);
    expect(await syncPolicy(ctx)).toBe("rejected");
    expect((await getState()).policy).toBeNull();
    expect(reported[0]).toMatchObject({ detector: "tamper_detected", reason: "bad_policy_signature" });
  });

  it("rejects a bundle whose signature was made by a different key under the pinned kid", async () => {
    const impostor = { ...otherKey, kid: "k1" };
    mockPolicyResponse([{ status: 200, json: await signEnvelope(makeBundle(), impostor) }]);
    expect(await syncPolicy(ctx)).toBe("rejected");
    expect((await getState()).policy).toBeNull();
  });

  it("does not report tamper for a response it cannot parse (a newer server), and keeps the last bundle", async () => {
    mockPolicyResponse([{ status: 200, json: { bundle: { v: 99 }, sig: "x", keyId: "k1", alg: "ES256" } }]);
    expect(await syncPolicy(ctx)).toBe("rejected");
    expect(reported).toEqual([]);
  });

  it("rejects a validly signed but older bundle (rollback) and keeps the newer one", async () => {
    const newer = await signEnvelope(makeBundle({ issuedAt: "2026-11-03T12:00:00.000Z", policyVersion: "b".repeat(64) }), key);
    const older = await signEnvelope(makeBundle({ issuedAt: "2026-11-02T12:00:00.000Z", policyVersion: "a".repeat(64) }), key);
    mockPolicyResponse([{ status: 200, json: newer }, { status: 200, json: older }]);
    expect(await syncPolicy(ctx)).toBe("updated");
    expect(await syncPolicy(ctx)).toBe("rejected");
    expect((await getState()).policy?.envelope.bundle.policyVersion).toBe("b".repeat(64));
    expect(reported.map((e) => e.detector)).toEqual(["tamper_detected"]);
  });

  it("rejects a validly signed bundle that is for another device", async () => {
    mockPolicyResponse([{ status: 200, json: await signEnvelope(makeBundle({ deviceId: "someone-else" }), key) }]);
    expect(await syncPolicy(ctx)).toBe("rejected");
    expect((await getState()).policy).toBeNull();
    expect(reported).toHaveLength(1);
  });

  it("verifies the object as received: fields this build does not know about are covered by the signature", async () => {
    const withExtra = { ...makeBundle(), futureField: { a: 1 } };
    mockPolicyResponse([{ status: 200, json: await signEnvelope(withExtra, key) }]);
    expect(await syncPolicy(ctx)).toBe("updated");
  });

  it("a network or server error keeps what it has and reports nothing", async () => {
    mockPolicyResponse([{ status: 503, json: { error: "x", code: "policy_signing_unavailable" } }]);
    expect(await syncPolicy(ctx)).toBe("unavailable");
    mockPolicyResponse([{ status: 404 }]);
    expect(await syncPolicy(ctx)).toBe("unavailable");
    expect(reported).toEqual([]);
  });
});

describe("fetching: If-None-Match and expiry", () => {
  it("sends the stored ETag, and a 304 changes nothing", async () => {
    const bundle = makeBundle();
    mockPolicyResponse([{ status: 200, json: await signEnvelope(bundle, key), etag: '"v1"' }, { status: 304, etag: '"v1"' }]);
    await syncPolicy(ctx);
    expect(requests[0]!.headers["if-none-match"]).toBeUndefined();
    expect(await syncPolicy(ctx)).toBe("unchanged");
    expect(requests[1]!.headers["if-none-match"]).toBe('"v1"');
  });

  it("omits If-None-Match within a day of the stored bundle's expiry", async () => {
    const soon = makeBundle({ expiresAt: new Date(Date.now() + 3600 * 1000).toISOString() });
    mockPolicyResponse([{ status: 200, json: await signEnvelope(soon, key), etag: '"v1"' }, { status: 200, json: await signEnvelope(soon, key), etag: '"v1"' }]);
    await syncPolicy(ctx);
    await syncPolicy(ctx);
    expect(requests[1]!.headers["if-none-match"]).toBeUndefined();
  });

  it("still enforces an expired stored bundle (expiry only means 'ask for a fresh one')", async () => {
    const expired = makeBundle({ expiresAt: new Date(Date.now() - 1000).toISOString(), web: { block: ["bad.example"] } });
    mockPolicyResponse([{ status: 200, json: await signEnvelope(expired, key) }, { status: 503 }]);
    await syncPolicy(ctx);
    await syncPolicy(ctx);
    expect((await getState()).policy?.envelope.bundle.web.block).toEqual(["bad.example"]);
  });
});

describe("applying a bundle", () => {
  it("removes every rule and the category data when the mode is not child", async () => {
    mockPolicyResponse([{ status: 200, json: await signEnvelope(makeBundle({ mode: "standard" }), key) }]);
    await syncPolicy(ctx);
    expect(dnrCalls).toHaveLength(1);
    expect(dnrCalls[0]!.addRules).toEqual([]);
    expect((await getState()).policyApplied).toBe("a".repeat(64));
  });

  it("is not 'applied' until the category files are in place, so the console keeps saying pending", async () => {
    const bundle = makeBundle({ web: { categories: ["adult"] } });
    mockPolicyResponse([{ status: 200, json: await signEnvelope(bundle, key) }]);
    // The lists response has not arrived yet.
    expect(await syncPolicy(ctx)).toBe("updated");
    expect((await getState()).policyApplied).toBeNull();
    // It arrives (an empty file is valid for the test) and the next apply completes.
    const empty = new ArrayBuffer(0);
    const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", empty))].map((b) => b.toString(16).padStart(2, "0")).join("");
    await updateState((s) => ({ ...s, lists: { version: "v", remoteAccessTools: [], pupPublishers: [], scamPagePhrases: [], skipDomains: [], brands: [], categoryLists: { version: "c1", baseUrl: "https://neo.test/category-lists/c1/", categories: { adult: { file: "adult.bin", sha256: sha, count: 0 } } } } }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(empty, { status: 200 })));
    await applyStoredPolicy(ctx);
    const state = await getState();
    expect(state.policyApplied).toBe(bundle.policyVersion);
    expect(state.categoryData).toEqual({ version: "c1", shas: { adult: sha } });
  });
});

describe("pinned keys", () => {
  it("parses a JSON array of JWKs with kids and rejects anything else", () => {
    expect(parsePolicyKeys(JSON.stringify([key.publicJwk]))).toHaveLength(1);
    expect(parsePolicyKeys("")).toBeNull();
    expect(parsePolicyKeys("not json")).toBeNull();
    expect(parsePolicyKeys("[]")).toBeNull();
    expect(parsePolicyKeys(JSON.stringify([{ ...key.publicJwk, kid: undefined }]))).toBeNull();
  });
});
