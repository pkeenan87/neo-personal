// @vitest-environment node
import type { MessageParam } from "@neo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as agentPOST } from "@/app/api/agent/route";
import { agentEffort, previousTurnPlaybook } from "@/lib/server/agent-run";
import { getConversationStore } from "@/lib/server/conversation-store";
import { DEV_SESSION_IDS } from "@/lib/session";
import { events, post, resetMemoryState, stubBaseEnv } from "./helpers/routes";

// Capture the request params the agent loop sends to the (scripted) model client.
const captured = vi.hoisted(() => ({ params: [] as Array<{ output_config?: { effort?: string } }> }));
vi.mock("@/lib/server/mock-model", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/server/mock-model")>();
  return {
    ...mod,
    createMockAnthropicClient: (opts?: Parameters<typeof mod.createMockAnthropicClient>[0]) => {
      const client = mod.createMockAnthropicClient(opts) as unknown as {
        messages: { stream: (p: unknown, o?: unknown) => unknown };
        beta: { messages: { stream: (p: unknown, o?: unknown) => unknown } };
      };
      const wrap = (fn: (p: unknown, o?: unknown) => unknown) => (p: unknown, o?: unknown) => {
        captured.params.push(p as { output_config?: { effort?: string } });
        return fn(p, o);
      };
      client.messages.stream = wrap(client.messages.stream);
      client.beta.messages.stream = wrap(client.beta.messages.stream);
      return client;
    },
  };
});

const lastEffort = () => captured.params.at(-1)?.output_config?.effort;

beforeEach(() => {
  stubBaseEnv(vi);
  vi.stubEnv("NEO_AGENT_EFFORT", "");
  resetMemoryState();
  captured.params = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/agent effort per turn", () => {
  it("runs a playbook turn with effort high", async () => {
    const res = await agentPOST(post("/api/agent", { message: "I think I clicked a link. Help me.", playbook: "clicked_link" }));
    expect(res.status).toBe(200);
    await events(res);
    expect(captured.params.length).toBeGreaterThan(0);
    expect(captured.params.every((p) => p.output_config?.effort === "high")).toBe(true);
  });

  it("uses the env default without a playbook", async () => {
    await events(await agentPOST(post("/api/agent", { message: "hello" })));
    expect(lastEffort()).toBe("medium");
    vi.stubEnv("NEO_AGENT_EFFORT", "low");
    await events(await agentPOST(post("/api/agent", { message: "hello again" })));
    expect(lastEffort()).toBe("low");
  });

  it("rejects an unknown playbook id", async () => {
    const res = await agentPOST(post("/api/agent", { message: "help", playbook: "rm_rf" }));
    expect(res.status).toBe(400);
  });

  it("stays high while the previous assistant turn declared a playbook", async () => {
    const store = getConversationStore();
    const { id } = await store.create({ tenantId: DEV_SESSION_IDS.tenantId, userId: DEV_SESSION_IDS.userId, title: "t" });
    await store.appendTurn(id, DEV_SESSION_IDS.tenantId, {
      messages: [
        { role: "user", content: "I think I shared a code. Help me." },
        { role: "assistant", content: [{ type: "text", text: "<!-- playbook:shared_code -->\nFirst, sign in to the real app." }] },
      ],
    });
    await events(await agentPOST(post("/api/agent", { message: "Done. What next?", conversationId: id })));
    expect(lastEffort()).toBe("high");

    // The mock model's reply has no marker, so the following turn drops back to the default.
    await events(await agentPOST(post("/api/agent", { message: "Thanks", conversationId: id })));
    expect(lastEffort()).toBe("medium");
  });
});

describe("agentEffort / previousTurnPlaybook", () => {
  const text = (role: "user" | "assistant", t: string): MessageParam => ({ role, content: t });

  it("detects the marker in any assistant message of the previous turn, across tool results", () => {
    const history: MessageParam[] = [
      text("user", "I sent money"),
      {
        role: "assistant",
        content: [
          { type: "text", text: "<!-- playbook:paid_scammer -->\nLet me check that link." },
          { type: "tool_use", id: "t1", name: "check_url", input: { url: "https://x.test" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "{}" }] },
      text("assistant", "Here is what to do next."),
    ];
    expect(previousTurnPlaybook(history)).toBe("paid_scammer");
    expect(agentEffort({ history })).toBe("high");
  });

  it("ignores markers from older turns, unknown ids, and markers not at the start", () => {
    expect(previousTurnPlaybook([text("assistant", "<!-- playbook:clicked_link -->\nx"), text("user", "new topic"), text("assistant", "ok")])).toBeNull();
    expect(previousTurnPlaybook([text("user", "x"), text("assistant", "<!-- playbook:format_disk -->\nx")])).toBeNull();
    expect(previousTurnPlaybook([text("user", "x"), text("assistant", "Sure. <!-- playbook:clicked_link -->")])).toBeNull();
    expect(agentEffort({ history: [] })).toBe("medium");
    expect(agentEffort({ playbook: "shared_code" })).toBe("high");
  });
});
