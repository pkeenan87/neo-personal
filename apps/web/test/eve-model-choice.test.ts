// @vitest-environment node
/**
 * Which model the eve chat uses (agent/lib/model-choice.ts, 2f): the caller's own routing preference and
 * family pick the model through the same router as the old chat, Haiku 4.5 gets neither thinking nor
 * effort, the gateway policy rides along, the choice is fixed for a turn, and a household over its usage
 * cap (or whose usage store is down) gets Neo's canned refusal instead of a model call.
 */
import { emptySessionView } from "eve/events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chooseModel, selectionForRoute } from "../agent/lib/model-choice";
import { isRefusalModel, REFUSAL_MODEL_ID } from "../agent/lib/usage-gate";
import { memoryAuditLog } from "@/lib/server/audit";
import { resetMemoryRoutingPreferences, setMemberPreferences } from "@/lib/server/routing-settings";
import { recordUsage, resetMemoryUsage } from "@/lib/server/usage";
import { stubBaseEnv } from "./helpers/routes";

const checkCapsSpy = vi.hoisted(() => ({ fail: false }));
vi.mock("@/lib/server/usage", async (orig) => {
  const real = await orig<typeof import("@/lib/server/usage")>();
  return {
    ...real,
    checkCaps: (tenantId: string) => {
      if (checkCapsSpy.fail) throw new Error("usage store down");
      return real.checkCaps(tenantId);
    },
  };
});

const KID = { principalType: "user", principalId: "u-kid", attributes: { tenantId: "t-home", role: "member" } };

interface Fake {
  ctx: Parameters<typeof chooseModel>[0];
  memoRuns: string[];
}

/** A dynamic-model context: memo caches by key like eve's does for the life of a turn. */
function fakeCtx(text: string, auth: unknown = KID, turnId = "turn-1", cache = new Map<string, unknown>()): Fake {
  const memoRuns: string[] = [];
  const ctx = {
    session: { id: "s1", auth: { current: auth, initiator: auth } },
    turn: { id: turnId, status: "running", input: [{ kind: "text", text }] },
    view: emptySessionView(),
    now: new Date(),
    memo: async (key: unknown, fn: (o: { idempotencyKey: string; abortSignal: AbortSignal }) => unknown) => {
      const k = JSON.stringify(key);
      if (!cache.has(k)) {
        memoRuns.push(k);
        cache.set(k, await fn({ idempotencyKey: "k", abortSignal: new AbortController().signal }));
      }
      return cache.get(k);
    },
    messages: async () => [],
  } as unknown as Fake["ctx"];
  return { ctx, memoRuns };
}

type Selection = { model: string; reasoning?: string; modelContextWindowTokens?: number; modelOptions?: { providerOptions?: Record<string, Record<string, unknown>> } };
const pick = async (text: string, auth?: unknown) => (await chooseModel(fakeCtx(text, auth).ctx)) as unknown as Selection;

beforeEach(() => {
  stubBaseEnv(vi);
  vi.stubEnv("MOCK_MODE", "false");
  vi.stubEnv("NEO_ROUTER", "rules");
  vi.stubEnv("NEO_MODEL_GATEWAY", "true");
  vi.stubEnv("AI_GATEWAY_API_KEY", "test-gateway-key");
  vi.stubEnv("NEO_MODEL_FAMILIES", "anthropic,openai,kimi,grok");
  resetMemoryRoutingPreferences();
  resetMemoryUsage();
  memoryAuditLog().length = 0;
  checkCapsSpy.fail = false;
});
afterEach(() => vi.unstubAllEnvs());

const HELLO = "hello there";
const LINK = "is https://example.com/login safe?";
const INCIDENT = "someone hacked my account and took my password";

describe("routing per preference (2f)", () => {
  it("balanced: small turn is Haiku 4.5 with no thinking, no effort, no reasoning; a link is Sonnet 5 with both", async () => {
    const small = await pick(HELLO);
    expect(small.model).toBe("anthropic/claude-haiku-4.5");
    expect(small.reasoning).toBeUndefined();
    expect(small.modelOptions?.providerOptions?.anthropic).toBeUndefined();
    expect(JSON.stringify(small)).not.toMatch(/thinking|effort|budget_tokens/);

    const medium = await pick(LINK);
    expect(medium.model).toBe("anthropic/claude-sonnet-5");
    expect(medium.modelOptions?.providerOptions?.anthropic).toEqual({ thinking: { type: "adaptive" }, effort: "medium" });
    expect(JSON.stringify(medium)).not.toContain("budget_tokens");
  });

  it("follows the caller's saved preference", async () => {
    await setMemberPreferences("t-home", "u-kid", { routingPreference: "intelligence" });
    expect((await pick(HELLO)).model).toBe("anthropic/claude-sonnet-5"); // small -> medium rung
    expect((await pick(LINK)).model).toBe("anthropic/claude-opus-5"); // medium -> large rung
    await setMemberPreferences("t-home", "u-kid", { routingPreference: "cost" });
    const cheap = await pick(INCIDENT); // large tier -> medium rung at medium effort
    expect(cheap.model).toBe("anthropic/claude-sonnet-5");
    expect(cheap.modelOptions?.providerOptions?.anthropic).toMatchObject({ effort: "medium" });
    await setMemberPreferences("t-home", "u-kid", { routingPreference: "balanced" });
    expect((await pick(INCIDENT)).model).toBe("anthropic/claude-opus-5");
  });

  it("follows the caller's model family, with reasoning (not Anthropic options) for other families", async () => {
    await setMemberPreferences("t-home", "u-kid", { modelFamily: "openai" });
    const openai = await pick(LINK);
    expect(openai.model).toBe("openai/gpt-6-sol");
    expect(openai.reasoning).toBe("medium");
    expect(openai.modelOptions?.providerOptions?.anthropic).toBeUndefined();
    expect(openai.modelOptions?.providerOptions?.gateway).toMatchObject({ order: ["openai"] });
    // A family the deployment has not enabled (or no gateway key) falls back to Anthropic, as in the old chat.
    vi.stubEnv("NEO_MODEL_FAMILIES", "anthropic");
    expect((await pick(LINK)).model).toBe("anthropic/claude-sonnet-5");
    vi.stubEnv("NEO_MODEL_FAMILIES", "anthropic,openai");
    vi.stubEnv("AI_GATEWAY_API_KEY", "");
    expect((await pick(LINK)).model).toBe("anthropic/claude-sonnet-5");
  });

  it("carries Neo's gateway policy and the large rung's fallback", async () => {
    const large = await pick(INCIDENT);
    expect(large.modelOptions?.providerOptions?.gateway).toMatchObject({
      zeroDataRetention: true,
      models: ["anthropic/claude-sonnet-5"],
      order: ["anthropic", "bedrock", "vertexAnthropic", "claudeaws"],
    });
    expect(large.modelContextWindowTokens).toBe(200_000);
  });

  it("reads the preference of the verified caller's tenant and user only", async () => {
    await setMemberPreferences("t-other", "u-kid", { routingPreference: "intelligence" });
    await setMemberPreferences("t-home", "u-someone-else", { routingPreference: "intelligence" });
    expect((await pick(HELLO)).model).toBe("anthropic/claude-haiku-4.5");
  });

  it("selectionForRoute never sends thinking or effort to Haiku, whatever the route says", () => {
    const sel = selectionForRoute({ model: "claude-haiku-4-5", effort: "high" }) as unknown as Selection;
    expect(sel.model).toBe("anthropic/claude-haiku-4.5");
    expect(sel.modelOptions?.providerOptions).not.toHaveProperty("anthropic");
    expect(sel.reasoning).toBeUndefined();
  });

  it("decides once per turn: a second model call in the turn does not route again", async () => {
    const cache = new Map<string, unknown>();
    const first = fakeCtx(HELLO, KID, "turn-1", cache);
    await chooseModel(first.ctx);
    expect(first.memoRuns).toEqual([JSON.stringify(["usage-gate", "turn-1"]), JSON.stringify(["route", "turn-1"])]);
    const again = fakeCtx(HELLO, KID, "turn-1", cache);
    await chooseModel(again.ctx);
    expect(again.memoRuns).toEqual([]);
    const next = fakeCtx(HELLO, KID, "turn-2", cache);
    await chooseModel(next.ctx);
    expect(next.memoRuns).toHaveLength(2);
  });

  it("a caller with no household (a local dev server) gets the medium rung and is not metered", async () => {
    const sel = (await chooseModel(fakeCtx(HELLO, { principalType: "local-dev", principalId: "dev", attributes: {} }).ctx)) as unknown as Selection;
    expect(sel.model).toBe("anthropic/claude-sonnet-5");
  });

  it("MOCK_MODE answers with the scripted model, after the same cap gate", async () => {
    vi.stubEnv("MOCK_MODE", "true");
    const sel = (await chooseModel(fakeCtx(HELLO).ctx)) as unknown as { model: { provider: string } };
    expect(sel.model.provider).toBe("eve-mock");
  });
});

async function refusalText(selection: unknown): Promise<string> {
  const model = (selection as { model: { modelId: string; doGenerate: (o: unknown) => Promise<{ content: { type: string; text?: string }[] }> } }).model;
  expect(model.modelId).toBe(REFUSAL_MODEL_ID);
  expect(isRefusalModel(`eve-mock/${model.modelId}`)).toBe(true);
  expect(isRefusalModel("anthropic/claude-sonnet-5")).toBe(false);
  const out = await model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
  return out.content.map((c) => c.text ?? "").join("");
}

describe("usage caps (2f)", () => {
  it("under the cap: a real model, no refusal", async () => {
    vi.stubEnv("USAGE_CAP_MONTHLY_CHECKS", "2");
    await recordUsage({ tenantId: "t-home", userId: "u-kid", model: "m", inputTokens: 1, outputTokens: 1 });
    expect((await pick(HELLO)).model).toBe("anthropic/claude-haiku-4.5");
  });

  it("over the monthly cap: Neo's sentence, no routing, one cap-hit audit event", async () => {
    vi.stubEnv("USAGE_CAP_MONTHLY_CHECKS", "1");
    await recordUsage({ tenantId: "t-home", userId: "u-kid", model: "m", inputTokens: 1, outputTokens: 1 });
    const turn = fakeCtx(HELLO);
    const sel = await chooseModel(turn.ctx);
    expect(await refusalText(sel)).toMatch(/Your household has used all of this month's free checks\. They reset on /);
    expect(turn.memoRuns).toEqual([JSON.stringify(["usage-gate", "turn-1"])]); // never reached the router
    await chooseModel(fakeCtx(HELLO).ctx);
    expect(memoryAuditLog().filter((e) => e.eventType === "usage.cap_hit")).toHaveLength(1);
  });

  it("over the daily token cap, and another household is unaffected", async () => {
    vi.stubEnv("USAGE_CAP_DAILY_TOKENS", "100");
    await recordUsage({ tenantId: "t-home", userId: "u-kid", model: "m", inputTokens: 90, outputTokens: 20 });
    expect(await refusalText(await chooseModel(fakeCtx(HELLO).ctx))).toBe("Your household has hit today's usage limit. It resets at midnight UTC.");
    const other = { principalType: "user", principalId: "u-z", attributes: { tenantId: "t-other", role: "owner" } };
    expect((await pick(HELLO, other)).model).toBe("anthropic/claude-haiku-4.5");
  });

  it("fails closed when the usage store is down", async () => {
    checkCapsSpy.fail = true;
    expect(await refusalText(await chooseModel(fakeCtx(HELLO).ctx))).toBe("Neo can't check your usage right now. Please try again in a moment.");
  });

  it("a refusal also holds in MOCK_MODE", async () => {
    vi.stubEnv("MOCK_MODE", "true");
    vi.stubEnv("USAGE_CAP_MONTHLY_CHECKS", "0");
    expect(await refusalText(await chooseModel(fakeCtx(HELLO).ctx))).toMatch(/free checks/);
  });
});
