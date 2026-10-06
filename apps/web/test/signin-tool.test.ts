// @vitest-environment node
import { wrapToolResult } from "@neo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildToolRegistry } from "@/lib/server/agent-run";
import { memorySigninStore } from "@/lib/server/signin/store";
import { resetMemoryState, stubBaseEnv } from "./helpers/routes";

const TENANT = "00000000-0000-4000-8000-0000000000cc";
const ctx = { tenantId: TENANT, userId: "member-1", conversationId: "c-1" };
const rec = (userId: string, extra: Record<string, unknown> = {}, tenantId = TENANT) =>
  memorySigninStore.record(tenantId, { userId, provider: "google", event: "new_signin", deviceLabel: "Windows", coarseLocation: "Seattle, WA", source: "forwarded", authenticated: true, ...extra } as never);

beforeEach(() => {
  stubBaseEnv(vi);
  resetMemoryState();
});

describe("review_my_signins chat tool", () => {
  const tool = () => buildToolRegistry({ mock: false }).get("review_my_signins")!;

  it("is registered through createToolRegistry with a blank-tolerant, selector-free schema", () => {
    const t = tool();
    expect(t).toBeDefined();
    expect(t.definition.input_schema).toMatchObject({ type: "object", additionalProperties: false });
    expect(Object.keys((t.definition.input_schema as { properties: object }).properties).sort()).toEqual(["limit", "provider"]);
  });

  it.each([[{}], [undefined], [{ provider: "", limit: null }], [{ provider: "  ", limit: 0 }], [{ provider: null, limit: "" }]])("accepts empty/blank input %j", async (input) => {
    await rec("member-1");
    const out = (await tool().execute(input, ctx)) as { count: number };
    expect(out.count).toBe(1);
  });

  it("returns only the session user's events, with known-device status, never other members', tenants' or ids", async () => {
    await rec("member-1");
    await rec("member-1", { provider: "apple", deviceLabel: "iPhone" });
    await rec("member-2", { deviceLabel: "SECRET-OTHER-MEMBER" });
    await rec("member-1", { deviceLabel: "OTHER-TENANT" }, "00000000-0000-4000-8000-0000000000dd");
    await memorySigninStore.rememberDevice(TENANT, "member-1", "apple", "iPhone");
    const out = (await tool().execute({}, ctx)) as { count: number; events: { provider: string; known_device: boolean }[] };
    expect(out.count).toBe(2);
    expect(out.events.map((e) => [e.provider, e.known_device]).sort()).toEqual([["apple", true], ["google", false]]);
    const text = JSON.stringify(out);
    expect(text).not.toContain("SECRET-OTHER-MEMBER");
    expect(text).not.toContain("OTHER-TENANT");
    expect(out.events[0]).not.toHaveProperty("verdictId");
    expect(out.events[0]).not.toHaveProperty("userId");
    expect(await tool().execute({ provider: "apple" }, ctx)).toMatchObject({ count: 1 });
    expect(await tool().execute({ limit: 1 }, ctx)).toMatchObject({ count: 1 });
  });

  it("rejects user/tenant selectors and unknown providers", async () => {
    for (const input of [{ userId: "member-2" }, { tenantId: TENANT }, { provider: "yahoo" }, { limit: 500 }]) {
      await expect(tool().execute(input, ctx)).rejects.toThrow();
    }
  });

  it("sanitizes stored values again at the output edge and its result is wrapped as untrusted tool output", async () => {
    await rec("member-1", { deviceLabel: "Win\u202Edows\u200B\u0007" + "A".repeat(300), coarseLocation: "Seattle\u2066" });
    const out = (await tool().execute({}, ctx)) as { events: { device: string; location_advisory: string }[] };
    expect(out.events[0]!.device).not.toMatch(/[\u202E\u200B\u0007]/);
    expect(out.events[0]!.device.length).toBeLessThanOrEqual(80);
    expect(out.events[0]!.location_advisory).toBe("Seattle");
    const envelope = JSON.parse(wrapToolResult("review_my_signins", out)) as { _neo_trust_boundary: { source: string; tool: string }; data: unknown };
    expect(envelope._neo_trust_boundary).toMatchObject({ source: "external_tool", tool: "review_my_signins" });
    expect(envelope.data).toBeDefined();
  });

  it("reports an empty history plainly", async () => {
    expect(await tool().execute({}, ctx)).toMatchObject({ count: 0, events: [] });
  });
});
