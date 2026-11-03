import { verdictJsonSchema } from "@neo/verdict";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildModelTextArgs } from "../src/model-text.js";
import { buildTriageRequest } from "../src/triage.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("buildModelTextArgs", () => {
  it("maps a direct Sonnet triage call onto Anthropic provider options, not a token budget", () => {
    const call = buildTriageRequest({ evidence: { subject: "hi" }, evidenceKind: "email", guidance: "Weigh DMARC." }, "claude-sonnet-5", "low");
    const args = buildModelTextArgs(call);

    expect(args.model).toMatchObject({ modelId: "claude-sonnet-5" });
    expect(typeof args.model).not.toBe("string");
    expect(args.maxOutputTokens).toBe(4096);
    expect(args.prompt).toContain("_neo_trust_boundary");
    expect(args.system).toMatchObject({
      role: "system",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
    expect(args.providerOptions?.anthropic).toEqual({
      thinking: { type: "adaptive" },
      effort: "low",
      structuredOutputMode: "outputFormat",
    });
    expect(args.providerOptions).not.toHaveProperty("gateway");
    expect(args).not.toHaveProperty("reasoning");
    expect(args.output).toBeDefined();
    expect(JSON.stringify(args.providerOptions)).not.toContain("budget_tokens");
    expect(JSON.stringify(args.providerOptions)).not.toContain("budgetTokens");
  });

  it("uses a gateway slug and gateway provider options when the gateway is on", () => {
    vi.stubEnv("NEO_MODEL_GATEWAY", "true");
    vi.stubEnv("AI_GATEWAY_API_KEY", "test-gateway-key");
    const call = buildTriageRequest({ evidence: {}, evidenceKind: "email", guidance: "" }, "anthropic/claude-sonnet-5", "medium");
    const args = buildModelTextArgs(call);

    expect(args.model).toBe("anthropic/claude-sonnet-5");
    expect(args.providerOptions?.gateway).toEqual({
      zeroDataRetention: true,
      inferenceRegion: { scope: "zone", geoRegion: "us" },
      order: ["anthropic", "bedrock", "vertexAnthropic", "claudeaws"],
    });
    expect(args.providerOptions?.anthropic).toMatchObject({ thinking: { type: "adaptive" }, effort: "medium" });
    expect(call.jsonSchema).toEqual(verdictJsonSchema);
  });

  it("sends Haiku compression with neither thinking nor effort", () => {
    const args = buildModelTextArgs({
      model: "claude-haiku-4-5",
      system: "Summarise. ## IDENTIFIERS",
      prompt: "<transcript>\nhi\n</transcript>",
      maxOutputTokens: 4096,
      anthropic: { userId: "abc123" },
    });

    expect(args.model).toMatchObject({ modelId: "claude-haiku-4-5" });
    expect(args.system).toBe("Summarise. ## IDENTIFIERS");
    expect(args.providerOptions).toEqual({ anthropic: { metadata: { userId: "abc123" } } });
    expect(args).not.toHaveProperty("output");
    expect(args).not.toHaveProperty("reasoning");
    const encoded = JSON.stringify(args.providerOptions);
    expect(encoded).not.toContain("thinking");
    expect(encoded).not.toContain("effort");
    expect(encoded).not.toContain("budget");
  });
});
