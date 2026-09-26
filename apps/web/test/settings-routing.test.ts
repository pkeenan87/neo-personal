// @vitest-environment node
import type { Session } from "next-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/settings/routing/route";
import type { RoutingSettings } from "@/lib/routing-types";
import { preferenceModels } from "@/lib/server/routing-settings";
import { post, resetMemoryState, stubBaseEnv } from "./helpers/routes";

const authState = vi.hoisted(() => ({ session: null as Session | null }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => authState.session) }));

const MEMBER = { userId: "user-m", tenantId: "00000000-0000-4000-8000-0000000000cc", role: "member" as const };

function signInAsMember(): void {
  vi.stubEnv("DEV_AUTH_BYPASS", "false");
  authState.session = { ...MEMBER, user: { email: "m@example.test", name: "M" }, expires: "2099-01-01T00:00:00Z" };
}

async function body(res: Response): Promise<RoutingSettings> {
  return (await res.json()) as RoutingSettings;
}

beforeEach(() => {
  stubBaseEnv(vi);
  vi.stubEnv("NEO_MODEL_FAMILIES", "");
  vi.stubEnv("NEO_MODEL_GATEWAY", "");
  vi.stubEnv("AI_GATEWAY_API_KEY", "");
  resetMemoryState();
  authState.session = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/settings/routing", () => {
  it("returns defaults and every family with its ladder", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const s = await body(res);
    expect(s.preference).toBe("balanced");
    expect(s.family).toBe("anthropic");
    expect(s.families.map((f) => [f.id, f.label, f.enabled])).toEqual([
      ["anthropic", "Anthropic", true],
      ["openai", "OpenAI", false],
      ["kimi", "Kimi", false],
      ["grok", "Grok", false],
    ]);
    const anthropic = s.families[0]!;
    expect(anthropic.caveat).toBeUndefined();
    expect(anthropic.ladder).toEqual([
      { tier: "small", model: "claude-haiku-4-5", displayName: "Haiku 4.5", pricing: { input: 1, output: 5 } },
      { tier: "medium", model: "claude-sonnet-5", displayName: "Sonnet 5", pricing: { input: 2, output: 10 } },
      { tier: "large", model: "claude-opus-5", displayName: "Opus 5", pricing: { input: 5, output: 25 } },
    ]);
    expect(s.families.find((f) => f.id === "grok")?.caveat).toBe("US hosting is not verifiable by the gateway");
  });

  it("reports gateway ids and enabled families from the environment", async () => {
    vi.stubEnv("NEO_MODEL_GATEWAY", "true");
    vi.stubEnv("AI_GATEWAY_API_KEY", "test-key");
    vi.stubEnv("NEO_MODEL_FAMILIES", "anthropic,openai");
    const s = await body(await GET());
    expect(s.families.filter((f) => f.enabled).map((f) => f.id)).toEqual(["anthropic", "openai"]);
    expect(s.families[0]!.ladder[1]!.model).toBe("anthropic/claude-sonnet-5");
    expect(s.families.find((f) => f.id === "kimi")!.ladder.map((r) => r.displayName)).toEqual(["Haiku 4.5", "Kimi K3", "Kimi K3"]);
  });

  it("returns 401 without a session", async () => {
    vi.stubEnv("DEV_AUTH_BYPASS", "false");
    const res = await GET();
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "unauthenticated" });
    expect((await POST(post("/api/settings/routing", { preference: "cost" }))).status).toBe(401);
  });
});

describe("POST /api/settings/routing", () => {
  it("saves the preference for a plain member and returns the GET shape", async () => {
    signInAsMember();
    const res = await POST(post("/api/settings/routing", { preference: "intelligence" }));
    expect(res.status).toBe(200);
    const s = await body(res);
    expect(s).toMatchObject({ preference: "intelligence", family: "anthropic" });
    expect(s.families).toHaveLength(4);
    expect(await body(await GET())).toMatchObject({ preference: "intelligence", family: "anthropic" });
  });

  it("keeps each member's settings separate", async () => {
    await POST(post("/api/settings/routing", { preference: "cost" })); // dev-bypass user
    signInAsMember();
    expect((await body(await GET())).preference).toBe("balanced");
  });

  it("accepts an enabled non-default family", async () => {
    vi.stubEnv("NEO_MODEL_FAMILIES", "openai");
    const res = await POST(post("/api/settings/routing", { family: "openai", preference: "cost" }));
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({ family: "openai", preference: "cost" });
  });

  it.each([
    ["an unknown preference", { preference: "cheapest" }],
    ["an unknown family", { family: "gemini" }],
    ["a family that is not enabled", { family: "grok" }],
    ["a non-string value", { preference: 1 }],
    ["an empty body", {}],
    ["a non-object body", ["cost"]],
  ])("rejects %s with 400 bad_request", async (_label, payload) => {
    const res = await POST(post("/api/settings/routing", payload));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "bad_request" });
    expect(await body(await GET())).toMatchObject({ preference: "balanced", family: "anthropic" });
  });
});

describe("preferenceModels", () => {
  it("derives each preference's models from the preference table", () => {
    const m = preferenceModels();
    expect(m.anthropic.cost.map((x) => `${x.displayName}/${x.effort}`)).toEqual(["Haiku 4.5/low", "Sonnet 5/low", "Sonnet 5/medium"]);
    expect(m.anthropic.balanced.map((x) => `${x.displayName}/${x.effort}`)).toEqual(["Haiku 4.5/low", "Sonnet 5/medium", "Opus 5/medium"]);
    expect(m.anthropic.intelligence.map((x) => `${x.displayName}/${x.effort}`)).toEqual(["Sonnet 5/low", "Opus 5/medium", "Opus 5/high"]);
    // Kimi K3 has no `medium`: clamped up to high.
    expect(m.kimi.balanced[1]).toEqual({ tier: "medium", displayName: "Kimi K3", effort: "high" });
  });
});
