import { describe, expect, it } from "vitest";
import { enabledFamilies, gatewayEnabled, gatewayRegion } from "../src/config.js";
import {
  MODEL_CATALOG,
  MODEL_FAMILIES,
  PREFERENCE_TABLE,
  ROUTING_PREFERENCES,
  TIERS,
  anthropicModelFor,
  catalogEntryFor,
  clampEffort,
  directModelId,
  displayNameFor,
  gatewayModelId,
  modelIdFor,
  pinnedRoute,
  resolveRoute,
} from "../src/routing.js";

const GATEWAY = { NEO_MODEL_GATEWAY: "true", AI_GATEWAY_API_KEY: "k" };
const ALL_FAMILIES = { ...GATEWAY, NEO_MODEL_FAMILIES: "openai,kimi,grok" };
const DIRECT = {};

describe("config: gateway flags", () => {
  it("gatewayEnabled needs the flag and the key", () => {
    expect(gatewayEnabled({})).toBe(false);
    expect(gatewayEnabled({ NEO_MODEL_GATEWAY: "true" })).toBe(false);
    expect(gatewayEnabled({ AI_GATEWAY_API_KEY: "k" })).toBe(false);
    expect(gatewayEnabled(GATEWAY)).toBe(true);
    expect(gatewayEnabled({ NEO_MODEL_GATEWAY: "off", AI_GATEWAY_API_KEY: "k" })).toBe(false);
  });
  it("gatewayRegion defaults to us", () => {
    expect(gatewayRegion({})).toBe("us");
    expect(gatewayRegion({ NEO_GATEWAY_REGION: "GLOBAL" })).toBe("global");
    expect(gatewayRegion({ NEO_GATEWAY_REGION: "eu" })).toBe("us");
  });
  it("enabledFamilies always includes anthropic and ignores unknown names", () => {
    expect(enabledFamilies({})).toEqual(["anthropic"]);
    expect(enabledFamilies({ NEO_MODEL_FAMILIES: "grok, Kimi,bogus" })).toEqual(["anthropic", "kimi", "grok"]);
  });
});

describe("catalog and tables", () => {
  it("every family and tier has a model with the expected shape", () => {
    for (const f of MODEL_FAMILIES) {
      for (const t of TIERS) {
        const m = MODEL_CATALOG[f][t];
        expect(m.id).toMatch(/^[a-z-]+\/[a-z0-9.-]+$/);
        expect(m.displayName.length).toBeGreaterThan(0);
        expect(m.order.length).toBeGreaterThan(0);
        expect(m.pricing.input).toBeGreaterThan(0);
        if (m.family === "anthropic") expect(m.directId).toBeDefined();
        else expect(m.directId).toBeUndefined();
      }
    }
  });
  it("every preference cell resolves", () => {
    for (const p of ROUTING_PREFERENCES) for (const t of TIERS) expect(PREFERENCE_TABLE[p][t]).toBeDefined();
  });
  it("Kimi borrows Haiku for the small tier and Grok exempts its providers from the region pin", () => {
    expect(MODEL_CATALOG.kimi.small).toBe(MODEL_CATALOG.anthropic.small);
    expect(MODEL_CATALOG.grok.medium.regionOverrides).toEqual({ xai: null, vertex: null });
  });
});

describe("id mapping", () => {
  it("maps direct ids to gateway slugs and back", () => {
    expect(gatewayModelId("claude-haiku-4-5")).toBe("anthropic/claude-haiku-4.5");
    expect(gatewayModelId("claude-opus-5-5")).toBe("anthropic/claude-opus-5.5");
    expect(gatewayModelId("openai/gpt-6-luna")).toBe("openai/gpt-6-luna");
    expect(gatewayModelId("claude-future-9")).toBe("anthropic/claude-future-9");
    expect(directModelId("anthropic/claude-haiku-4.5")).toBe("claude-haiku-4-5");
    expect(directModelId("anthropic/claude-future-9")).toBe("claude-future-9");
    expect(directModelId("openai/gpt-6-luna")).toBeUndefined();
  });
  it("displayNameFor knows both forms and falls back to the id", () => {
    expect(displayNameFor("claude-sonnet-5")).toBe("Sonnet 5");
    expect(displayNameFor("anthropic/claude-opus-5.5")).toBe("Opus 5.5");
    expect(displayNameFor("neo-mock-model")).toBe("Mock model");
    expect(displayNameFor("acme/unknown")).toBe("acme/unknown");
  });
});

describe("clampEffort", () => {
  it("returns listed levels unchanged and leaves effort-less models alone", () => {
    expect(clampEffort(MODEL_CATALOG.anthropic.medium, "high")).toBe("high");
    expect(clampEffort(MODEL_CATALOG.anthropic.small, "medium")).toBe("medium");
  });
  it("picks the nearest level, higher on ties (Kimi K3 has no medium)", () => {
    expect(clampEffort(MODEL_CATALOG.kimi.medium, "medium")).toBe("high");
    expect(clampEffort(MODEL_CATALOG.kimi.medium, "low")).toBe("low");
  });
});

describe("resolveRoute", () => {
  it("balanced maps tiers to the Anthropic ladder with gateway ids when the gateway is on", () => {
    const r = resolveRoute({ tier: "medium", preference: "balanced", family: "anthropic", router: "jev", source: GATEWAY });
    expect(r).toMatchObject({ tier: "medium", family: "anthropic", model: "anthropic/claude-sonnet-5", displayName: "Sonnet 5", effort: "medium", router: "jev" });
  });
  it("uses direct ids when the gateway is off", () => {
    expect(resolveRoute({ tier: "large", preference: "balanced", family: "anthropic", router: "rule", source: DIRECT }).model).toBe("claude-opus-5");
    expect(resolveRoute({ tier: "small", preference: "balanced", family: "anthropic", router: "rule", source: DIRECT }).model).toBe("claude-haiku-4-5");
  });
  it("cost shifts down and intelligence shifts up, clamped", () => {
    expect(resolveRoute({ tier: "large", preference: "cost", family: "anthropic", router: "jev", source: GATEWAY })).toMatchObject({ model: "anthropic/claude-sonnet-5", effort: "medium" });
    expect(resolveRoute({ tier: "small", preference: "cost", family: "anthropic", router: "jev", source: GATEWAY })).toMatchObject({ model: "anthropic/claude-haiku-4.5", effort: "low" });
    expect(resolveRoute({ tier: "small", preference: "intelligence", family: "anthropic", router: "jev", source: GATEWAY })).toMatchObject({ model: "anthropic/claude-sonnet-5", effort: "low" });
    expect(resolveRoute({ tier: "large", preference: "intelligence", family: "anthropic", router: "jev", source: GATEWAY })).toMatchObject({ model: "anthropic/claude-opus-5", effort: "high" });
  });
  it("falls back to Anthropic when the family is not enabled or the gateway is off", () => {
    expect(resolveRoute({ tier: "medium", preference: "balanced", family: "openai", router: "jev", source: GATEWAY })).toMatchObject({ family: "anthropic", model: "anthropic/claude-sonnet-5" });
    expect(resolveRoute({ tier: "medium", preference: "balanced", family: "openai", router: "jev", source: { NEO_MODEL_FAMILIES: "openai" } })).toMatchObject({ family: "anthropic", model: "claude-sonnet-5" });
  });
  it("uses the enabled family's ladder", () => {
    expect(resolveRoute({ tier: "small", preference: "balanced", family: "openai", router: "jev", source: ALL_FAMILIES })).toMatchObject({ family: "openai", model: "openai/gpt-6-luna", effort: "low" });
    expect(resolveRoute({ tier: "medium", preference: "balanced", family: "kimi", router: "jev", source: ALL_FAMILIES })).toMatchObject({ family: "kimi", model: "moonshotai/kimi-k3", effort: "high" });
    expect(resolveRoute({ tier: "small", preference: "balanced", family: "kimi", router: "jev", source: ALL_FAMILIES })).toMatchObject({ family: "anthropic", model: "anthropic/claude-haiku-4.5" });
    expect(resolveRoute({ tier: "large", preference: "intelligence", family: "grok", router: "jev", source: ALL_FAMILIES })).toMatchObject({ family: "grok", model: "spacexai/grok-4.6", effort: "high" });
  });
  it("carries signals through", () => {
    const signals = { complexity: 1, stakes: 0, needsTools: true, confidence: 0.9 };
    expect(resolveRoute({ tier: "medium", preference: "balanced", family: "anthropic", router: "jev", signals, source: GATEWAY }).signals).toEqual(signals);
  });
});

describe("env overrides", () => {
  it("NEO_MODEL_<TIER> and the legacy variables override the Anthropic ladder in either id form", () => {
    expect(anthropicModelFor("large", { NEO_MODEL_LARGE: "claude-opus-5-5" })).toMatchObject({ id: "anthropic/claude-opus-5.5", directId: "claude-opus-5-5", displayName: "Opus 5.5", tier: "large" });
    expect(anthropicModelFor("large", { NEO_AGENT_MODEL: "anthropic/claude-opus-5.5" }).directId).toBe("claude-opus-5-5");
    expect(anthropicModelFor("large", { NEO_MODEL_LARGE: "claude-opus-5" })).toBe(MODEL_CATALOG.anthropic.large);
    expect(anthropicModelFor("small", { NEO_COMPRESSION_MODEL: "claude-haiku-4-5" })).toBe(MODEL_CATALOG.anthropic.small);
  });
  it("modelIdFor throws for a gateway-only model when the gateway is off", () => {
    expect(() => modelIdFor(MODEL_CATALOG.openai.small, DIRECT)).toThrow(/NEO_MODEL_GATEWAY/);
    expect(modelIdFor(MODEL_CATALOG.openai.small, GATEWAY)).toBe("openai/gpt-6-luna");
  });
});

describe("pinnedRoute", () => {
  it("pins compression, triage and playbooks to the Anthropic ladder", () => {
    expect(pinnedRoute("compression", DIRECT)).toMatchObject({ model: "claude-haiku-4-5", tier: "small", router: "pinned", effort: "low" });
    expect(pinnedRoute("triage", GATEWAY)).toMatchObject({ model: "anthropic/claude-sonnet-5", tier: "medium", effort: "low" });
    expect(pinnedRoute("playbook", GATEWAY)).toMatchObject({ model: "anthropic/claude-opus-5", tier: "large", effort: "high", signals: { reason: "playbook" } });
    expect(pinnedRoute("triage", { NEO_TRIAGE_MODEL: "claude-sonnet-5" }).model).toBe("claude-sonnet-5");
  });
  it("catalogEntryFor finds entries in either id form", () => {
    expect(catalogEntryFor("claude-sonnet-5")?.displayName).toBe("Sonnet 5");
    expect(catalogEntryFor("spacexai/grok-4.7")?.family).toBe("grok");
    expect(catalogEntryFor("acme/none")).toBeUndefined();
  });
});
