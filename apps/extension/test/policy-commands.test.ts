// @vitest-environment node
/**
 * The extension ignores the `commands` of a bundle (_specs/v2-m3-cutover.md section 4: they are for the
 * desktop agent), but a bundle that carries them, or a kind it has never heard of, must still verify and
 * apply: the signature covers the bundle as sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { __resetStateChainForTests, getState, updateState } from "../lib/state.js";
import { syncPolicy, type DnrApi, type PolicyContext } from "../lib/policy/sync.js";
import { MemoryBinStore } from "../lib/policy/store.js";
import { makeBundle, makeKey, signEnvelope, type TestKey } from "./helpers/policy.js";

let key: TestKey;
let ctx: PolicyContext;
const dnr: DnrApi = { getDynamicRules: async () => [], updateDynamicRules: async () => {} };

beforeEach(async () => {
  fakeBrowser.reset();
  __resetStateChainForTests();
  key = await makeKey("k1");
  await updateState((s) => ({ ...s, connection: "enrolled", token: "neo_dt_x", deviceId: "d1", serverUrl: "https://neo.test" }));
  ctx = { serverUrl: "https://neo.test", token: "neo_dt_x", report: async () => true, keys: [key.publicJwk], store: new MemoryBinStore(), dnr };
});
afterEach(() => vi.unstubAllGlobals());

function serve(json: unknown): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } })));
}

describe("a bundle with commands", () => {
  const commands = [
    { id: "33333333-3333-4333-8333-333333333333", kind: "end_session", sessionRef: { toolId: "anydesk", peerId: "1 2 3" }, requiresConfirmation: true, expiresAt: "2026-11-03T12:10:00.000Z" },
    { id: "44444444-4444-4444-8444-444444444444", kind: "a_kind_from_a_newer_server", sessionRef: { toolId: "anydesk" }, requiresConfirmation: false, expiresAt: "2026-11-03T12:10:00.000Z" },
  ];

  it("verifies and applies as any other bundle, and the commands play no part in the web rules", async () => {
    const bundle = { ...makeBundle({ web: { block: ["bad.example"] } }), commands };
    serve(await signEnvelope(bundle, key));
    expect(await syncPolicy(ctx)).toBe("updated");
    const state = await getState();
    expect(state.policy?.envelope.bundle.policyVersion).toBe(bundle.policyVersion);
    expect(state.policyApplied).toBe(bundle.policyVersion);
  });

  it("still rejects the bundle when a command is changed after signing", async () => {
    const bundle = { ...makeBundle(), commands };
    const envelope = await signEnvelope(bundle, key);
    serve({ ...envelope, bundle: { ...bundle, commands: [{ ...commands[0]!, requiresConfirmation: false }] } });
    expect(await syncPolicy(ctx)).toBe("rejected");
    expect((await getState()).policy).toBeNull();
  });
});
