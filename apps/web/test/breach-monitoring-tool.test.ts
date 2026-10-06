import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wrapToolResult } from "@neo/core";
import { buildToolRegistry } from "@/lib/server/agent-run";
import { resetMemoryState, stubBaseEnv } from "./helpers/routes";

const state = vi.hoisted(() => ({
  tenantId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  load: vi.fn(),
}));
vi.mock("@/lib/server/breach-monitoring/status-service", () => ({ getBreachStatusForUser: state.load }));

beforeEach(() => {
  stubBaseEnv(vi);
  resetMemoryState();
  state.load.mockReset().mockResolvedValue({
    status: "breached",
    lastSuccessfulCheckAt: "2026-10-05T12:00:00.000Z",
    pendingCount: 0,
    addresses: [{ id: "33333333-3333-4333-8333-333333333333", email: "private@example.com", source: "sign_in", verificationStatus: "verified", status: "breached", verifiedAt: "2026-10-01T00:00:00.000Z", lastCheckedAt: "2026-10-05T12:00:00.000Z", lastSuccessfulCheckAt: "2026-10-05T12:00:00.000Z", observations: [{ breachName: "Example Breach", domain: "example.com", breachDate: "2024-01-02", addedDate: null, dataClasses: ["Passwords"], firstSeenAt: "2026-10-05T12:00:00.000Z", lastSeenAt: "2026-10-05T12:00:00.000Z", retiredAt: null }] }],
    attribution: { label: "Have I Been Pwned", url: "https://haveibeenpwned.com", license: "CC BY 4.0" },
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("check_breaches chat tool", () => {
  it("is registered with empty input, session scope, no address data, and wrapped output", async () => {
    const registry = buildToolRegistry({ mock: false });
    const tool = registry.get("check_breaches");
    expect(tool).toBeDefined();
    expect(tool!.definition.input_schema).toMatchObject({ type: "object", properties: {}, required: [], additionalProperties: false });
    const result = await tool!.execute({}, { tenantId: state.tenantId, userId: state.userId, conversationId: "conversation-1" });
    expect(state.load).toHaveBeenCalledWith({ tenantId: state.tenantId, userId: state.userId });
    expect(JSON.stringify(result)).not.toContain("private@example.com");
    expect(JSON.stringify(result)).not.toContain("33333333-3333-4333-8333-333333333333");
    expect(JSON.stringify(result)).toContain("Example Breach");
    const riskySnapshot = {
      status: "breached",
      lastSuccessfulCheckAt: null,
      pendingCount: 0,
      addresses: [{
        id: "44444444-4444-4444-8444-444444444444", email: "private@example.com", source: "extra", verificationStatus: "verified",
        status: "breached", verifiedAt: "2026-10-01T00:00:00.000Z", lastCheckedAt: null, lastSuccessfulCheckAt: null,
        observations: [{ breachName: "victim@example.test", domain: null, breachDate: null, addedDate: null, dataClasses: [], firstSeenAt: "2026-10-01T00:00:00.000Z", lastSeenAt: "2026-10-01T00:00:00.000Z", retiredAt: null }],
      }],
      attribution: { label: "Have I Been Pwned", url: "https://haveibeenpwned.com", license: "CC BY 4.0" },
    };
    state.load.mockResolvedValueOnce(riskySnapshot);
    const riskyResult = await tool!.execute({}, { tenantId: state.tenantId, userId: state.userId, conversationId: "conversation-1" });
    expect(JSON.stringify(riskyResult)).not.toContain("victim@example.test");
    expect(JSON.stringify(riskyResult)).toContain("[redacted address]");
    const envelope = JSON.parse(wrapToolResult(tool!.definition.name, result)) as { _neo_trust_boundary?: { source?: string; tool?: string } };
    expect(envelope._neo_trust_boundary).toMatchObject({ source: "external_tool", tool: "check_breaches" });
  });

  it("rejects tenant, user, address selectors, and free-form input", async () => {
    const tool = buildToolRegistry({ mock: false }).get("check_breaches")!;
    await expect(tool.execute({ userId: "other" }, { tenantId: state.tenantId, userId: state.userId, conversationId: "conversation-1" })).rejects.toThrow();
    expect(state.load).not.toHaveBeenCalled();
  });
});
