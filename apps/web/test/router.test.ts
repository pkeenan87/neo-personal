import { afterEach, describe, expect, it, vi } from "vitest";
import { experimental_evaluate } from "ai";
import { Experimental_EvaluationMockModelV4 } from "ai/test";
import {
  decideTier,
  redactForRouting,
  routeTurn,
  rulesTier,
  type EvaluateFn,
  type JevAnswers,
  type RouteTurnInput,
} from "@/lib/server/router";

const GATEWAY_ENV = { NEO_MODEL_GATEWAY: "true", AI_GATEWAY_API_KEY: "k" };

const THANKS = "thanks!";
const LINK = "is https://example.com safe?";
const DRAINED = "my bank account was drained after I entered my password on a link";

function input(text: string, over: Partial<RouteTurnInput> = {}): RouteTurnInput {
  return {
    text,
    hasAttachment: false,
    attachmentKind: null,
    priorTurns: 0,
    previousVerdict: null,
    playbook: null,
    preference: "balanced",
    family: "anthropic",
    ...over,
  };
}

function score(level: 0 | 1 | 2): JevAnswers["complexity"] {
  const probabilities: Record<string, number> = { "0": 0.05, "1": 0.05, "2": 0.05 };
  probabilities[String(level)] = 0.9;
  const s = Object.entries(probabilities).reduce((acc, [k, p]) => acc + Number(k) * p, 0);
  return { type: "score", score: s, probabilities };
}

function answers(complexity: 0 | 1 | 2, stakes: 0 | 1 | 2, needsTools: number): JevAnswers {
  return { complexity: score(complexity), stakes: score(stakes), needs_tools: { type: "boolean", probability: needsTools } };
}

const CONFIDENT = { complexity: 0.9, stakes: 0.9 };

/** Jev's answers for the three acceptance messages. */
const JEV_FIXTURES: Record<string, JevAnswers> = {
  [THANKS]: answers(0, 0, 0.02),
  "is example.com safe?": answers(1, 0, 0.97),
  [DRAINED]: answers(2, 2, 0.4),
};

/** A real `experimental_evaluate` call against the AI SDK mock evaluation model. */
function mockModelEvaluate(confidence: Record<string, number> | null = CONFIDENT) {
  const calls: Array<{ state: unknown; providerOptions: unknown }> = [];
  const model = new Experimental_EvaluationMockModelV4({
    provider: "typesafe-ai",
    modelId: "jev",
    supportedQuestionTypes: ["choice", "score", "boolean"],
    doEvaluate: async (opts) => {
      calls.push({ state: opts.state, providerOptions: opts.providerOptions });
      const message = (opts.state as { message: string }).message;
      const a = JEV_FIXTURES[message];
      if (!a) throw new Error(`no fixture for ${message}`);
      return {
        answers: { ...a },
        warnings: [],
        ...(confidence ? { providerMetadata: { typesafe: { confidence } } } : {}),
      };
    },
  });
  const evaluate: EvaluateFn = (options) =>
    experimental_evaluate({ ...options, model });
  return { evaluate, calls };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("redactForRouting", () => {
  it("reduces URLs to their registrable domain", () => {
    expect(redactForRouting("go to https://login.example-bank.co.uk/x?y now")).toBe("go to example-bank.co.uk now");
    expect(redactForRouting("see http://a.b.example.com:8080/path#frag, then")).toBe("see example.com, then");
    expect(redactForRouting("www.shop.example.com.au/deal")).toBe("example.com.au");
  });

  it("keeps the domain when the message is only a URL", () => {
    expect(redactForRouting("https://secure-login.paypa1.com/verify/123456789")).toBe("paypa1.com");
  });

  it("masks email addresses and phone numbers", () => {
    expect(redactForRouting("from alice.smith+x@mail.example.org")).toBe("from [email]");
    expect(redactForRouting("call +1 (555) 123-4567 or 555.123.4567")).toBe("call [phone] or [phone]");
    expect(redactForRouting("code 1234 expires")).toBe("code 1234 expires");
  });

  it("collapses whitespace and caps at 4000 characters", () => {
    expect(redactForRouting("  a \n\n b\t c  ")).toBe("a b c");
    expect(redactForRouting("x".repeat(10_000))).toHaveLength(4000);
  });
});

describe("decideTier", () => {
  it("routes the acceptance messages", () => {
    expect(decideTier(JEV_FIXTURES[THANKS]!, CONFIDENT, true).tier).toBe("small");
    const link = decideTier(JEV_FIXTURES["is example.com safe?"]!, CONFIDENT, true);
    expect(link.tier).toBe("medium");
    expect(link.signals.needsTools).toBe(true);
    expect(decideTier(JEV_FIXTURES[DRAINED]!, CONFIDENT, true).tier).toBe("large");
  });

  it("lifts small to medium when needs_tools fires", () => {
    expect(decideTier(answers(0, 0, 0.8), CONFIDENT, true).tier).toBe("medium");
    expect(decideTier(answers(0, 0, 0.8), CONFIDENT, false).tier).toBe("small");
  });

  it("lifts to at least medium on low or missing confidence", () => {
    expect(decideTier(answers(0, 0, 0), { complexity: 0.9, stakes: 0.5 }, true).tier).toBe("medium");
    expect(decideTier(answers(0, 0, 0), { complexity: 0.9 }, true).tier).toBe("medium");
    expect(decideTier(answers(0, 0, 0), undefined, true).tier).toBe("medium");
    expect(decideTier(answers(2, 0, 0), undefined, true).tier).toBe("large");
  });

  it("uses the rounded score when probabilities are missing, and reports signals", () => {
    const a: JevAnswers = {
      complexity: { type: "score", score: 1.4 },
      stakes: { type: "score", score: 0.2 },
      needs_tools: { type: "boolean", probability: 0.1 },
    };
    expect(decideTier(a, { complexity: 0.7, stakes: 0.95 }, true)).toEqual({
      tier: "medium",
      signals: { complexity: 1, stakes: 0, needsTools: false, confidence: 0.7, reason: "Jev: complexity 1/2, stakes 0/2" },
    });
  });
});

describe("rulesTier", () => {
  it("routes the acceptance messages", () => {
    expect(rulesTier(input(THANKS))).toBe("small");
    expect(rulesTier(input(LINK))).toBe("medium");
    expect(rulesTier(input(DRAINED))).toBe("large");
  });

  it("uses structure and the previous verdict", () => {
    expect(rulesTier(input(""))).toBe("small");
    expect(rulesTier(input("what about this?", { hasAttachment: true, attachmentKind: "image" }))).toBe("medium");
    expect(rulesTier(input("ok", { previousVerdict: "suspicious" }))).toBe("medium");
    expect(rulesTier(input("ok", { previousVerdict: "malicious" }))).toBe("large");
    expect(rulesTier(input("text from 555-123-4567"))).toBe("medium");
    expect(rulesTier(input("a".repeat(241)))).toBe("medium");
    expect(rulesTier(input("I got a wireless router"))).toBe("small");
  });
});

describe("routeTurn", () => {
  it("pins playbook turns to large without calling Jev", async () => {
    const evaluate = vi.fn<EvaluateFn>();
    const route = await routeTurn(input("help", { playbook: "entered_password", preference: "cost" }), {
      evaluate,
      env: GATEWAY_ENV,
    });
    expect(evaluate).not.toHaveBeenCalled();
    expect(route).toMatchObject({ tier: "large", router: "pinned", preference: "cost", model: "anthropic/claude-opus-5", effort: "high" });
    expect(route.signals?.reason).toBe("Playbook");
  });

  it("returns a jev route with the resolved model for the preference and family", async () => {
    const { evaluate, calls } = mockModelEvaluate();
    const env = { ...GATEWAY_ENV, NEO_MODEL_FAMILIES: "anthropic,openai" };

    const small = await routeTurn(input(THANKS), { evaluate, env });
    expect(small).toMatchObject({ tier: "small", router: "jev", family: "anthropic", model: "anthropic/claude-haiku-4.5" });

    const link = await routeTurn(input(LINK, { preference: "intelligence" }), { evaluate, env });
    expect(link).toMatchObject({ tier: "medium", router: "jev", model: "anthropic/claude-opus-5", preference: "intelligence" });
    expect(link.signals).toMatchObject({ needsTools: true, reason: "Jev: complexity 1/2, stakes 0/2" });

    const large = await routeTurn(input(DRAINED, { family: "openai" }), { evaluate, env });
    expect(large).toMatchObject({ tier: "large", router: "jev", family: "openai", model: "openai/gpt-6-astra" });

    expect(calls[1]).toEqual({
      state: { message: "is example.com safe?", has_attachment: false, attachment_kind: null, prior_turns: 0, previous_verdict: null },
      providerOptions: { gateway: { zeroDataRetention: true } },
    });
  });

  it("honors NEO_ROUTER_ZDR=false", async () => {
    const { evaluate, calls } = mockModelEvaluate();
    await routeTurn(input(THANKS), { evaluate, env: { ...GATEWAY_ENV, NEO_ROUTER_ZDR: "false" } });
    expect(calls[0]?.providerOptions).toEqual({ gateway: { zeroDataRetention: false } });
  });

  it("treats missing Jev confidence as low", async () => {
    const { evaluate } = mockModelEvaluate(null);
    const route = await routeTurn(input(THANKS), { evaluate, env: GATEWAY_ENV });
    expect(route).toMatchObject({ tier: "medium", router: "jev" });
  });

  it("falls back to rules after the 1.5 s timeout", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let aborted = false;
    const evaluate: EvaluateFn = ({ abortSignal }) =>
      new Promise(() => {
        abortSignal.addEventListener("abort", () => (aborted = true));
      });
    const pending = routeTurn(input(DRAINED), { evaluate, env: GATEWAY_ENV });
    await vi.advanceTimersByTimeAsync(1500);
    const route = await pending;
    expect(aborted).toBe(true);
    expect(route).toMatchObject({ tier: "large", router: "rule", signals: { reason: "Fallback rule" } });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(JSON.parse(line).meta.errorType).toBe("timeout");
    expect(line).not.toContain("drained");
  });

  it("falls back to rules when Jev throws, without logging the message", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const evaluate: EvaluateFn = async () => {
      throw Object.assign(new Error("No providers available for typesafe-ai/jev with zeroDataRetention"), {
        name: "GatewayInvalidRequestError",
        code: "no_providers_available",
      });
    };
    const route = await routeTurn(input(LINK), { evaluate, env: GATEWAY_ENV });
    expect(route).toMatchObject({ tier: "medium", router: "rule", signals: { reason: "Fallback rule" } });
    const line = String(warn.mock.calls[0]?.[0]);
    expect(JSON.parse(line).meta).toMatchObject({ errorType: "no_providers_available" });
    expect(line).not.toContain("example.com");
  });

  it("falls back when the caller aborts", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const controller = new AbortController();
    const evaluate: EvaluateFn = () => new Promise(() => {});
    const pending = routeTurn(input(THANKS, { signal: controller.signal }), { evaluate, env: GATEWAY_ENV });
    controller.abort();
    await expect(pending).resolves.toMatchObject({ tier: "small", router: "rule" });
  });

  it("uses rules in MOCK_MODE even with the gateway on", async () => {
    const evaluate = vi.fn<EvaluateFn>();
    const route = await routeTurn(input(DRAINED), { evaluate, env: { ...GATEWAY_ENV, MOCK_MODE: "true", NEO_ROUTER: "jev" } });
    expect(evaluate).not.toHaveBeenCalled();
    expect(route).toMatchObject({ tier: "large", router: "rule", signals: { reason: "Rules" } });
  });

  it("defaults to rules when the gateway is off", async () => {
    const evaluate = vi.fn<EvaluateFn>();
    const route = await routeTurn(input(THANKS), { evaluate, env: {} });
    expect(evaluate).not.toHaveBeenCalled();
    expect(route).toMatchObject({ tier: "small", router: "rule", model: "claude-haiku-4-5" });
  });

  it("always routes medium with NEO_ROUTER=off", async () => {
    const evaluate = vi.fn<EvaluateFn>();
    const route = await routeTurn(input(DRAINED), { evaluate, env: { ...GATEWAY_ENV, NEO_ROUTER: "off" } });
    expect(evaluate).not.toHaveBeenCalled();
    expect(route).toMatchObject({ tier: "medium", router: "rule", model: "anthropic/claude-sonnet-5" });
  });
});
