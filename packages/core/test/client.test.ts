import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  createModelClient,
  gatewayProviderOptions,
  modelEntryFor,
  requestShape,
  resetModelClientForTests,
  withGatewayOptions,
} from "../src/client.js";
import { refusalFallbacksEnabled } from "../src/config.js";
import { MODEL_CATALOG } from "../src/routing.js";

const GATEWAY = { NEO_MODEL_GATEWAY: "true", AI_GATEWAY_API_KEY: "test-gateway-key" };
const DIRECT = {};

afterEach(() => resetModelClientForTests());

describe("createModelClient", () => {
  it("points at AI Gateway with the gateway key and never forwards an Anthropic auth token", () => {
    const client = createModelClient({ ...GATEWAY, ANTHROPIC_AUTH_TOKEN: "anthropic-token" });
    expect(client).toBeInstanceOf(Anthropic);
    expect(client.baseURL).toBe("https://ai-gateway.vercel.sh");
    expect(client.apiKey).toBe("test-gateway-key");
    expect(client.authToken).toBeNull();
  });

  it("caches one client per mode", () => {
    const a = createModelClient(GATEWAY);
    expect(createModelClient(GATEWAY)).toBe(a);
    const direct = createModelClient(DIRECT);
    expect(direct).not.toBe(a);
    expect(direct.baseURL).not.toContain("ai-gateway");
    resetModelClientForTests();
    expect(createModelClient(GATEWAY)).not.toBe(a);
  });
});

describe("withGatewayOptions", () => {
  const params = { model: "anthropic/claude-sonnet-5", max_tokens: 10 };

  it("is a no-op when the gateway is off", () => {
    expect(withGatewayOptions(params, MODEL_CATALOG.anthropic.medium, DIRECT)).toBe(params);
    expect(withGatewayOptions(params, MODEL_CATALOG.anthropic.medium, { NEO_MODEL_GATEWAY: "true" })).toBe(params);
  });

  it("adds ZDR, the US pin and the Anthropic provider order", () => {
    const out = withGatewayOptions(params, MODEL_CATALOG.anthropic.medium, GATEWAY);
    expect(out).toEqual({
      ...params,
      providerOptions: {
        gateway: {
          zeroDataRetention: true,
          inferenceRegion: { scope: "zone", geoRegion: "us" },
          order: ["anthropic", "bedrock", "vertexAnthropic", "claudeaws"],
        },
      },
    });
    expect(params).not.toHaveProperty("providerOptions");
  });

  it("exempts Grok's providers from the US pin", () => {
    expect(gatewayProviderOptions(MODEL_CATALOG.grok.medium, GATEWAY)).toEqual({
      gateway: {
        zeroDataRetention: true,
        inferenceRegion: { scope: "zone", geoRegion: "us", providers: { xai: null, vertex: null } },
        order: ["xai", "vertex"],
      },
    });
  });

  it("omits the region pin with NEO_GATEWAY_REGION=global but keeps ZDR", () => {
    const out = withGatewayOptions(params, MODEL_CATALOG.openai.large, { ...GATEWAY, NEO_GATEWAY_REGION: "global" }) as Record<string, unknown>;
    expect(out.providerOptions).toEqual({ gateway: { zeroDataRetention: true, order: ["openai"] } });
  });
});

describe("requestShape", () => {
  it("sends neither thinking nor effort to Haiku 4.5", () => {
    expect(requestShape(MODEL_CATALOG.anthropic.small, "medium", { summarizedThinking: true })).toEqual({});
  });

  it("sends adaptive thinking and effort to Sonnet 5, never budget_tokens", () => {
    expect(requestShape(MODEL_CATALOG.anthropic.medium, "low")).toEqual({
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
    });
    const streamed = requestShape(MODEL_CATALOG.anthropic.medium, "medium", { summarizedThinking: true });
    expect(streamed.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(JSON.stringify(streamed)).not.toContain("budget_tokens");
  });

  it("clamps Kimi K3's effort (no medium level) to high", () => {
    expect(requestShape(MODEL_CATALOG.kimi.medium, "medium").output_config).toEqual({ effort: "high" });
  });
});

describe("modelEntryFor", () => {
  it("returns catalog entries and an adaptive Anthropic stand-in for unknown ids", () => {
    expect(modelEntryFor("claude-haiku-4-5", DIRECT)).toBe(MODEL_CATALOG.anthropic.small);
    const unknown = modelEntryFor("claude-opus-4-8", DIRECT);
    expect(unknown).toMatchObject({ id: "anthropic/claude-opus-4-8", directId: "claude-opus-4-8", thinking: "adaptive" });
    expect(unknown.order).toEqual(MODEL_CATALOG.anthropic.large.order);
    expect(modelEntryFor("acme/model-x", DIRECT).order).toEqual([]);
  });
});

describe("refusalFallbacksEnabled", () => {
  it("defaults on direct, off on the gateway unless explicitly enabled", () => {
    expect(refusalFallbacksEnabled(DIRECT)).toBe(true);
    expect(refusalFallbacksEnabled({ NEO_ENABLE_FALLBACKS: "false" })).toBe(false);
    expect(refusalFallbacksEnabled(GATEWAY)).toBe(false);
    expect(refusalFallbacksEnabled({ ...GATEWAY, NEO_ENABLE_FALLBACKS: "maybe" })).toBe(false);
    expect(refusalFallbacksEnabled({ ...GATEWAY, NEO_ENABLE_FALLBACKS: "true" })).toBe(true);
  });
});
