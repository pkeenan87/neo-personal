// @vitest-environment node
import { wrapToolResult, type AgentResult, type MessageParam } from "@neo/core";
import type { Verdict } from "@neo/verdict";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamAgentRun } from "@/lib/server/agent-run";
import { getConversationStore } from "@/lib/server/conversation-store";
import { memoryVerdicts } from "@/lib/server/memory-state";
import { DEV_SESSION_IDS, type NeoSession } from "@/lib/session";
import { events, resetMemoryState, stubBaseEnv } from "./helpers/routes";
import { analyzeRaw, googleAlertRaw, triaged } from "./signin-fixtures";

vi.mock("@/lib/server/signin/service", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/signin/service")>()),
  finalizeSigninVerdict: vi.fn(async () => {
    throw new Error("boom: Seattle 203.0.113.24");
  }),
}));

const session: NeoSession = { tenantId: DEV_SESSION_IDS.tenantId, userId: DEV_SESSION_IDS.userId, role: "owner", email: "o@example.test", name: "Owner", scopes: ["full"] };
const fence = (v: Verdict) => `Here is what I found.\n\n\`\`\`verdict\n${JSON.stringify(v, null, 2)}\n\`\`\``;

async function runTurn(newMessages: MessageParam[]) {
  const { id } = await getConversationStore().create({ tenantId: session.tenantId, userId: session.userId, title: "t" });
  const user: MessageParam = { role: "user", content: "check this" };
  const res = streamAgentRun({
    session, conversationId: id, prefix: [user], kind: "check", signal: new AbortController().signal,
    run: async (): Promise<AgentResult> => ({ messages: [user, ...newMessages], newMessages, usage: { input_tokens: 1, output_tokens: 1 }, stopReason: "end_turn" }),
  });
  return events(res);
}

beforeEach(() => {
  stubBaseEnv(vi);
  resetMemoryState();
});
afterEach(() => vi.unstubAllEnvs());

describe("chat path: the sign-in hook throws", () => {
  it("caps a likely_safe verdict on a sign-in alert to suspicious, with no check, and streams the override", async () => {
    const analysis = await analyzeRaw(googleAlertRaw());
    expect(analysis.signin_alert).toBeDefined();
    const msgs: MessageParam[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "analyze_email", input: { raw: "x" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: wrapToolResult("analyze_email", analysis) }] },
      { role: "assistant", content: [{ type: "text", text: fence(triaged("likely_safe")) }] },
    ];
    const evs = await runTurn(msgs);
    const rows = memoryVerdicts();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.verdict).toMatchObject({ verdict: "suspicious", subject_type: "signin_alert" });
    expect(rows[0]!.verdict.signin_check).toBeUndefined();
    expect(JSON.stringify(rows[0]!.verdict)).not.toContain("boom");
    const override = evs.find((e) => e.type === "verdict_override") as Extract<(typeof evs)[number], { type: "verdict_override" }> | undefined;
    expect(override?.verdict).toMatchObject({ verdict: "suspicious", subject_type: "signin_alert" });
  });

  it("leaves a verdict on a turn with no sign-in alert alone", async () => {
    const msgs: MessageParam[] = [{ role: "assistant", content: [{ type: "text", text: fence(triaged("likely_safe")) }] }];
    // No analysis, not a sign-in subject: the hook is not even reached.
    await runTurn(msgs);
    expect(memoryVerdicts()[0]!.verdict.verdict).toBe("likely_safe");
  });
});
