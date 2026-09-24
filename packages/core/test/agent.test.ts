import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REFUSAL_MESSAGE, resumeAfterConfirmation, runAgentLoop } from "../src/agent.js";
import { hashPii } from "../src/logger.js";
import type { AgentEvent, RunAgentOptions } from "../src/types.js";
import {
  collector,
  ctx,
  endTurn,
  fakeClient,
  registry,
  text,
  thinking,
  tool,
  toolTurn,
  toolUse,
  type TurnScript,
} from "./helpers.js";

const userMsg = (t: string): MessageParam => ({ role: "user", content: t });

function setup(turns: TurnScript[], extra: Partial<RunAgentOptions> = {}) {
  const fake = fakeClient(turns);
  const { events, onEvent } = collector();
  const opts: RunAgentOptions = {
    messages: [userMsg("is this link safe? https://example.test")],
    system: "You are Neo.",
    tools: registry(tool("check_url")),
    ctx,
    onEvent,
    client: fake.client,
    retry: { baseDelayMs: 0 },
    ...extra,
  };
  return { fake, events, opts };
}

const types = (events: AgentEvent[]) => events.map((e) => e.type);

beforeEach(() => {
  delete process.env.NEO_AGENT_MODEL;
  delete process.env.NEO_ENABLE_FALLBACKS;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("runAgentLoop — basic turn", () => {
  it("streams text deltas, emits usage and done, and appends the assistant message", async () => {
    const { events, opts } = setup([endTurn("Looks safe.")]);
    const res = await runAgentLoop(opts);

    expect(types(events)).toEqual(["text_delta", "usage", "done"]);
    expect(events[0]).toEqual({ type: "text_delta", text: "Looks safe." });
    expect(events.at(-1)).toEqual({ type: "done", stop_reason: "end_turn" });
    expect(res.stopReason).toBe("end_turn");
    expect(res.messages).toHaveLength(2);
    expect(res.newMessages).toEqual([{ role: "assistant", content: [text("Looks safe.")] }]);
    expect(res.usage.input_tokens).toBe(100);
    expect(res.usage.output_tokens).toBe(20);
  });

  it("forwards summarized thinking deltas as thinking events", async () => {
    const { events, opts } = setup([{ content: [thinking("Checking the domain"), text("ok")], stop_reason: "end_turn" }]);
    await runAgentLoop(opts);
    expect(events[0]).toEqual({ type: "thinking", text: "Checking the domain" });
    expect(events[1]).toEqual({ type: "text_delta", text: "ok" });
  });

  it("does not mutate the caller's messages array", async () => {
    const { opts } = setup([endTurn()]);
    const input = opts.messages;
    await runAgentLoop(opts);
    expect(input).toHaveLength(1);
  });

  it("keeps running when onEvent throws", async () => {
    const { opts } = setup([endTurn()], {
      onEvent: () => {
        throw new Error("client went away");
      },
    });
    const res = await runAgentLoop(opts);
    expect(res.stopReason).toBe("end_turn");
  });
});

describe("runAgentLoop — request shape", () => {
  it("uses Opus 5 defaults: adaptive summarized thinking, medium effort, 16000 max_tokens, no budget_tokens", async () => {
    const { fake, opts } = setup([endTurn()]);
    await runAgentLoop(opts);
    const p = fake.streamCalls[0]!.params;
    expect(p.model).toBe("claude-opus-5");
    expect(p.max_tokens).toBe(16000);
    expect(p.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(p.output_config).toEqual({ effort: "medium" });
    expect(JSON.stringify(p)).not.toContain("budget_tokens");
    expect(p).not.toHaveProperty("temperature");
  });

  it("sends a hashed user id in metadata, never the raw id", async () => {
    const { fake, opts } = setup([endTurn()]);
    await runAgentLoop(opts);
    const p = fake.streamCalls[0]!.params;
    expect(p.metadata).toEqual({ user_id: hashPii(ctx.userId) });
    expect(JSON.stringify(p)).not.toContain(ctx.userId);
  });

  it("honours model / effort / maxTokens options and NEO_AGENT_MODEL", async () => {
    const a = setup([endTurn()], { model: "claude-sonnet-5", effort: "low", maxTokens: 4000 });
    await runAgentLoop(a.opts);
    expect(a.fake.streamCalls[0]!.params).toMatchObject({
      model: "claude-sonnet-5",
      max_tokens: 4000,
      output_config: { effort: "low" },
    });

    process.env.NEO_AGENT_MODEL = "claude-opus-5-test";
    const b = setup([endTurn()]);
    await runAgentLoop(b.opts);
    expect(b.fake.streamCalls[0]!.params.model).toBe("claude-opus-5-test");
  });

  it("puts cache breakpoints on the system prompt, the last tool, and the last message block", async () => {
    const { fake, opts } = setup([endTurn()], {
      tools: registry(tool("zeta"), tool("alpha"), tool("mid")),
    });
    await runAgentLoop(opts);
    const p = fake.streamCalls[0]!.params as {
      system: Array<Record<string, unknown>>;
      tools: Array<Record<string, unknown>>;
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };
    expect(p.system).toEqual([{ type: "text", text: "You are Neo.", cache_control: { type: "ephemeral" } }]);
    // Deterministic order (sorted by name) keeps the cached prefix stable.
    expect(p.tools.map((t) => t.name)).toEqual(["alpha", "mid", "zeta"]);
    expect(p.tools[2]!.cache_control).toEqual({ type: "ephemeral" });
    expect(p.tools[0]).not.toHaveProperty("cache_control");
    expect(p.messages.at(-1)!.content.at(-1)!.cache_control).toEqual({ type: "ephemeral" });

    const breakpoints = JSON.stringify(p).match(/cache_control/g) ?? [];
    expect(breakpoints.length).toBeLessThanOrEqual(4);
  });

  it("strips stray cache_control from history so the request stays within 4 breakpoints", async () => {
    const stray = { type: "ephemeral" as const };
    const { fake, opts } = setup([endTurn()], {
      messages: [
        { role: "user", content: [{ type: "text", text: "a", cache_control: stray }] },
        { role: "assistant", content: [{ type: "text", text: "b", cache_control: stray }] },
        { role: "user", content: [{ type: "text", text: "c", cache_control: stray }] },
        { role: "assistant", content: [{ type: "text", text: "d", cache_control: stray }] },
        userMsg("e"),
      ],
    });
    await runAgentLoop(opts);
    const count = (JSON.stringify(fake.streamCalls[0]!.params).match(/cache_control/g) ?? []).length;
    expect(count).toBe(3);
  });

  it("omits tools entirely when the registry is empty", async () => {
    const { fake, opts } = setup([endTurn()], { tools: registry() });
    await runAgentLoop(opts);
    expect(fake.streamCalls[0]!.params).not.toHaveProperty("tools");
  });

  it("uses the beta endpoint with server-side fallbacks by default", async () => {
    const { fake, opts } = setup([endTurn()]);
    await runAgentLoop(opts);
    const call = fake.streamCalls[0]!;
    expect(call.beta).toBe(true);
    expect(call.params.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(call.params.fallbacks).toBe("default");
  });

  it("uses the stable endpoint without fallbacks when disabled (option or NEO_ENABLE_FALLBACKS=false)", async () => {
    const a = setup([endTurn()], { enableFallbacks: false });
    await runAgentLoop(a.opts);
    expect(a.fake.streamCalls[0]!.beta).toBe(false);
    expect(a.fake.streamCalls[0]!.params).not.toHaveProperty("fallbacks");
    expect(a.fake.streamCalls[0]!.params).not.toHaveProperty("betas");

    process.env.NEO_ENABLE_FALLBACKS = "false";
    const b = setup([endTurn()]);
    await runAgentLoop(b.opts);
    expect(b.fake.streamCalls[0]!.beta).toBe(false);
  });

  it("passes the context AbortSignal to the SDK", async () => {
    const controller = new AbortController();
    const { fake, opts } = setup([endTurn()], { ctx: { ...ctx, signal: controller.signal } });
    await runAgentLoop(opts);
    expect(fake.streamCalls[0]!.signal).toBe(controller.signal);
  });
});

describe("runAgentLoop — tools", () => {
  it("runs parallel tool calls concurrently and returns all results in one user message", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const slow = (name: string) =>
      tool(name, async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return { tool: name };
      });
    const { fake, events, opts } = setup(
      [toolTurn(text("checking both"), toolUse("tu_a", "check_a", { u: 1 }), toolUse("tu_b", "check_b")), endTurn()],
      { tools: registry(slow("check_a"), slow("check_b")) },
    );
    const res = await runAgentLoop(opts);

    expect(maxInFlight).toBe(2);
    expect(res.stopReason).toBe("end_turn");
    const resultsMsg = res.messages[2]!;
    expect(resultsMsg.role).toBe("user");
    const blocks = resultsMsg.content as Array<{ type: string; tool_use_id: string; content: string }>;
    expect(blocks.map((b) => [b.type, b.tool_use_id])).toEqual([
      ["tool_result", "tu_a"],
      ["tool_result", "tu_b"],
    ]);
    // Every result enters the model through the trust-boundary envelope.
    for (const b of blocks) {
      const env = JSON.parse(b.content) as { _neo_trust_boundary: { tool: string } };
      expect(env._neo_trust_boundary.tool).toMatch(/check_[ab]/);
    }
    expect(events.filter((e) => e.type === "tool_start")).toEqual([
      { type: "tool_start", id: "tu_a", name: "check_a", input: { u: 1 } },
      { type: "tool_start", id: "tu_b", name: "check_b", input: {} },
    ]);
    expect(events.filter((e) => e.type === "tool_result")).toHaveLength(2);

    // The follow-up request carries the assistant tool_use turn and the results.
    const second = fake.streamCalls[1]!.params.messages as MessageParam[];
    expect(second).toHaveLength(3);
    expect(second[1]!.role).toBe("assistant");
  });

  it("returns is_error results for failing tools and keeps going", async () => {
    const { events, opts } = setup(
      [toolTurn(toolUse("tu_1", "check_url")), endTurn("sorry")],
      {
        tools: registry(
          tool("check_url", async () => {
            throw new Error("lookup timed out");
          }),
        ),
      },
    );
    const res = await runAgentLoop(opts);
    const block = (res.messages[2]!.content as Array<{ is_error?: boolean; content: string }>)[0]!;
    expect(block.is_error).toBe(true);
    expect(JSON.parse(block.content).data).toEqual({ error: "lookup timed out" });
    expect(events).toContainEqual({
      type: "tool_result",
      id: "tu_1",
      name: "check_url",
      result: { error: "lookup timed out" },
      is_error: true,
    });
    expect(res.stopReason).toBe("end_turn");
  });

  it("answers calls to unregistered tools with is_error", async () => {
    const { opts } = setup([toolTurn(toolUse("tu_x", "delete_everything")), endTurn()]);
    const res = await runAgentLoop(opts);
    const block = (res.messages[2]!.content as Array<{ is_error?: boolean; content: string }>)[0]!;
    expect(block.is_error).toBe(true);
    expect(block.content).toContain("Unknown tool");
  });

  it("passes the tool context to executors", async () => {
    const execute = vi.fn(async () => "ok");
    const { opts } = setup([toolTurn(toolUse("tu_1", "check_url", { url: "x" })), endTurn()], {
      tools: registry(tool("check_url", execute)),
    });
    await runAgentLoop(opts);
    expect(execute).toHaveBeenCalledWith({ url: "x" }, ctx);
  });

  it("stops at maxIterations", async () => {
    const { events, opts } = setup(
      [toolTurn(toolUse("t1", "check_url")), toolTurn(toolUse("t2", "check_url")), endTurn()],
      { maxIterations: 2 },
    );
    const res = await runAgentLoop(opts);
    expect(res.stopReason).toBe("max_iterations");
    expect(events.filter((e) => e.type === "error")).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: "done", stop_reason: "max_iterations" });
  });
});

describe("runAgentLoop — destructive confirmation gate", () => {
  const destructiveRegistry = (block = vi.fn(async () => ({ blocked: true })), lookup = vi.fn(async () => ({ found: 1 }))) => ({
    block,
    lookup,
    tools: registry(
      tool("lookup_sender", lookup),
      tool("block_sender", block, { destructive: true, description: "Block this sender in your mailbox" }),
    ),
  });

  it("pauses before a destructive tool, after running the non-destructive ones", async () => {
    const r = destructiveRegistry();
    const { events, opts } = setup(
      [toolTurn(text("looking up first"), toolUse("tu_lookup", "lookup_sender"), toolUse("tu_block", "block_sender", { s: "x" }))],
      { tools: r.tools },
    );
    const res = await runAgentLoop(opts);

    expect(r.lookup).toHaveBeenCalledOnce();
    expect(r.block).not.toHaveBeenCalled();
    expect(res.stopReason).toBe("confirmation_required");
    expect(res.pendingConfirmation).toEqual({ id: "tu_block", name: "block_sender", input: { s: "x" } });
    expect(events).toContainEqual({
      type: "confirmation_required",
      id: "tu_block",
      name: "block_sender",
      input: { s: "x" },
      description: "Block this sender in your mailbox",
    });
    expect(events.at(-1)).toEqual({ type: "done", stop_reason: "confirmation_required" });
    // History: user, assistant(tool_use x2), user(pre-executed lookup result).
    expect(res.messages).toHaveLength(3);
    const pre = res.messages[2]!.content as Array<{ tool_use_id: string }>;
    expect(pre.map((b) => b.tool_use_id)).toEqual(["tu_lookup"]);
    expect(events.some((e) => e.type === "tool_start" && e.id === "tu_block")).toBe(false);
  });

  it("with only a destructive tool, history ends on the assistant tool_use", async () => {
    const r = destructiveRegistry();
    const { opts } = setup([toolTurn(toolUse("tu_block", "block_sender"))], { tools: r.tools });
    const res = await runAgentLoop(opts);
    expect(res.messages).toHaveLength(2);
    expect(res.messages[1]!.role).toBe("assistant");
  });

  it("rejects a second destructive tool in the same message", async () => {
    const r = destructiveRegistry();
    const { opts } = setup(
      [toolTurn(toolUse("tu_1", "block_sender", { s: 1 }), toolUse("tu_2", "block_sender", { s: 2 }))],
      { tools: r.tools },
    );
    const res = await runAgentLoop(opts);
    expect(res.pendingConfirmation?.id).toBe("tu_1");
    const results = res.messages[2]!.content as Array<{ tool_use_id: string; is_error?: boolean }>;
    expect(results).toEqual([expect.objectContaining({ tool_use_id: "tu_2", is_error: true })]);
  });

  it("resumeAfterConfirmation(approved) runs the tool and continues with every tool_use paired", async () => {
    const r = destructiveRegistry();
    const first = setup(
      [toolTurn(toolUse("tu_lookup", "lookup_sender"), toolUse("tu_block", "block_sender", { s: "x" }))],
      { tools: r.tools },
    );
    const paused = await runAgentLoop(first.opts);

    const second = setup([endTurn("Blocked.")], { tools: r.tools, messages: paused.messages });
    const res = await resumeAfterConfirmation({ ...second.opts, approved: true, pending: paused.pendingConfirmation! });

    expect(r.block).toHaveBeenCalledWith({ s: "x" }, ctx);
    expect(res.stopReason).toBe("end_turn");
    expect(second.events.slice(0, 2)).toEqual([
      { type: "tool_start", id: "tu_block", name: "block_sender", input: { s: "x" } },
      { type: "tool_result", id: "tu_block", name: "block_sender", result: { blocked: true } },
    ]);
    // newMessages: the confirmed result + the final assistant message.
    expect(res.newMessages.map((m) => m.role)).toEqual(["user", "assistant"]);

    // The API request merges the split tool results into ONE user turn.
    const sent = second.fake.streamCalls[0]!.params.messages as MessageParam[];
    expect(sent.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    const ids = (sent[2]!.content as Array<{ type: string; tool_use_id?: string }>).map((b) => b.tool_use_id);
    expect(ids).toEqual(["tu_lookup", "tu_block"]);
  });

  it("resumeAfterConfirmation(declined) does not run the tool and tells the model", async () => {
    const r = destructiveRegistry();
    const first = setup([toolTurn(toolUse("tu_block", "block_sender"))], { tools: r.tools });
    const paused = await runAgentLoop(first.opts);

    const second = setup([endTurn("OK, I won't.")], { tools: r.tools, messages: paused.messages });
    const res = await resumeAfterConfirmation({ ...second.opts, approved: false, pending: paused.pendingConfirmation! });

    expect(r.block).not.toHaveBeenCalled();
    const result = (res.messages[2]!.content as Array<{ content: string; tool_use_id: string }>)[0]!;
    expect(result.tool_use_id).toBe("tu_block");
    const env = JSON.parse(result.content) as { _neo_trust_boundary: unknown; data: { cancelled: boolean } };
    expect(env._neo_trust_boundary).toBeDefined();
    expect(env.data.cancelled).toBe(true);
    expect(second.events[0]).toMatchObject({ type: "tool_result", id: "tu_block", is_error: true });
    expect(res.stopReason).toBe("end_turn");
  });

  it("rejects a stale or forged confirmation without running anything", async () => {
    const r = destructiveRegistry();
    const first = setup([toolTurn(toolUse("tu_block", "block_sender"))], { tools: r.tools });
    const paused = await runAgentLoop(first.opts);

    const second = setup([], { tools: r.tools, messages: paused.messages });
    const res = await resumeAfterConfirmation({
      ...second.opts,
      approved: true,
      pending: { id: "tu_other", name: "block_sender", input: {} },
    });
    expect(r.block).not.toHaveBeenCalled();
    expect(res.stopReason).toBe("error");
    expect(types(second.events)).toEqual(["error", "done"]);
    expect(second.fake.streamCalls).toHaveLength(0);

    // Non-destructive tool names cannot be "confirmed" either.
    const third = setup([], { tools: r.tools, messages: paused.messages });
    const res2 = await resumeAfterConfirmation({
      ...third.opts,
      approved: true,
      pending: { id: "tu_block", name: "lookup_sender", input: {} },
    });
    expect(res2.stopReason).toBe("error");
  });

  it("a new user message instead of confirming is repaired (orphan tool_use dropped from the request)", async () => {
    const r = destructiveRegistry();
    const first = setup([toolTurn(text("I'll block it"), toolUse("tu_block", "block_sender"))], { tools: r.tools });
    const paused = await runAgentLoop(first.opts);

    const second = setup([endTurn()], {
      tools: r.tools,
      messages: [...paused.messages, userMsg("actually, never mind")],
    });
    await runAgentLoop(second.opts);
    const sent = second.fake.streamCalls[0]!.params.messages as MessageParam[];
    expect(JSON.stringify(sent)).not.toContain("tu_block");
    expect(r.block).not.toHaveBeenCalled();
  });
});

describe("runAgentLoop — stop reasons", () => {
  it("refusal: emits a user-safe error, discards partial output, and does not append it", async () => {
    const { events, opts } = setup([
      { content: [text("partial")], stop_reason: "refusal", stop_details: { category: "cyber", explanation: "x" } },
    ]);
    const res = await runAgentLoop(opts);
    expect(res.stopReason).toBe("refusal");
    expect(res.error).toBe(REFUSAL_MESSAGE);
    expect(events).toContainEqual({ type: "error", message: REFUSAL_MESSAGE });
    expect(events.at(-1)).toEqual({ type: "done", stop_reason: "refusal" });
    expect(res.newMessages).toEqual([]);
  });

  it("refusal with a tool_use never runs the tool", async () => {
    const execute = vi.fn(async () => "x");
    const { opts } = setup([{ content: [toolUse("tu_1", "check_url")], stop_reason: "refusal" }], {
      tools: registry(tool("check_url", execute)),
    });
    await runAgentLoop(opts);
    expect(execute).not.toHaveBeenCalled();
  });

  it("max_tokens on a text answer returns the partial text with a [truncated] marker", async () => {
    const { events, opts } = setup([{ content: [text("Half an ans")], stop_reason: "max_tokens" }]);
    const res = await runAgentLoop(opts);
    expect(res.stopReason).toBe("max_tokens");
    expect(res.newMessages[0]!.content).toEqual([text("Half an ans"), { type: "text", text: "[truncated]" }]);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("max_tokens mid tool_use does not run the (possibly truncated) tool", async () => {
    const execute = vi.fn(async () => "x");
    const { events, opts } = setup(
      [{ content: [text("let me check"), toolUse("tu_1", "check_url", { url: "htt" })], stop_reason: "max_tokens" }],
      { tools: registry(tool("check_url", execute)) },
    );
    const res = await runAgentLoop(opts);
    expect(execute).not.toHaveBeenCalled();
    expect(res.stopReason).toBe("max_tokens");
    expect(JSON.stringify(res.messages)).not.toContain("tool_use");
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("pause_turn re-sends the paused assistant turn and continues", async () => {
    const { fake, opts } = setup([{ content: [text("working")], stop_reason: "pause_turn" }, endTurn()]);
    const res = await runAgentLoop(opts);
    expect(res.stopReason).toBe("end_turn");
    expect(fake.streamCalls).toHaveLength(2);
    const sent = fake.streamCalls[1]!.params.messages as MessageParam[];
    expect(sent.at(-1)!.role).toBe("assistant");
  });
});

describe("runAgentLoop — fallbacks", () => {
  it("drops the declined model's thinking / tool_use before the fallback boundary", async () => {
    const execute = vi.fn(async () => "x");
    const { opts } = setup(
      [
        {
          content: [
            thinking("declined model thinking"),
            text("Partial from primary. "),
            toolUse("tu_old", "check_url"),
            { type: "fallback", from: { model: "claude-opus-5" }, to: { model: "claude-opus-4-8" } },
            text("Continued by fallback."),
          ],
          stop_reason: "end_turn",
          model: "claude-opus-4-8",
          usage: { iterations: [{ type: "message" }, { type: "fallback_message" }] },
        },
      ],
      { tools: registry(tool("check_url", execute)) },
    );
    const res = await runAgentLoop(opts);
    expect(res.newMessages[0]!.content).toEqual([text("Partial from primary. "), text("Continued by fallback.")]);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("runAgentLoop — errors and retries", () => {
  const overloaded = () =>
    new Anthropic.InternalServerError(
      529,
      { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
      "Overloaded",
      new Headers(),
      "overloaded_error",
    );

  it("retries a 529 that fails before any output", async () => {
    const { fake, events, opts } = setup([{ error: overloaded() }, endTurn("second try")]);
    const res = await runAgentLoop(opts);
    expect(fake.streamCalls).toHaveLength(2);
    expect(res.stopReason).toBe("end_turn");
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("retries a mid-stream overloaded SSE error (no HTTP status)", async () => {
    const sseError = new Anthropic.APIError(
      undefined,
      { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
      undefined,
      new Headers(),
      "overloaded_error",
    );
    const { fake, opts } = setup([{ error: sseError }, endTurn()]);
    await runAgentLoop(opts);
    expect(fake.streamCalls).toHaveLength(2);
  });

  it("gives up after maxRetries with a user-safe message", async () => {
    const { fake, events, opts } = setup([{ error: overloaded() }, { error: overloaded() }, { error: overloaded() }], {
      retry: { maxRetries: 2, baseDelayMs: 0 },
    });
    const res = await runAgentLoop(opts);
    expect(fake.streamCalls).toHaveLength(3);
    expect(res.stopReason).toBe("error");
    expect(res.error).toMatch(/temporarily overloaded/);
    expect(events.at(-1)).toEqual({ type: "done", stop_reason: "error" });
  });

  it("does not retry once deltas reached the client (no duplicated text)", async () => {
    const { fake, events, opts } = setup([{ partialText: "Hel", error: overloaded() }, endTurn()]);
    const res = await runAgentLoop(opts);
    expect(fake.streamCalls).toHaveLength(1);
    expect(res.stopReason).toBe("error");
    expect(types(events)).toEqual(["text_delta", "error", "done"]);
  });

  it("does not retry a 400 and never leaks the raw API message", async () => {
    const bad = new Anthropic.BadRequestError(
      400,
      { type: "error", error: { type: "invalid_request_error", message: "secret internal detail" } },
      "secret internal detail",
      new Headers(),
      "invalid_request_error",
    );
    const { fake, events, opts } = setup([{ error: bad }]);
    const res = await runAgentLoop(opts);
    expect(fake.streamCalls).toHaveLength(1);
    expect(res.stopReason).toBe("error");
    expect(JSON.stringify(events)).not.toContain("secret internal detail");
  });

  it("returns an interrupted result when the signal aborts mid-stream", async () => {
    const controller = new AbortController();
    const { events, opts } = setup([{ hangUntilAbort: true }], { ctx: { ...ctx, signal: controller.signal } });
    const pending = runAgentLoop(opts);
    setTimeout(() => controller.abort(), 5);
    const res = await pending;
    expect(res.stopReason).toBe("interrupted");
    expect(res.newMessages).toEqual([{ role: "assistant", content: [{ type: "text", text: "[interrupted]" }] }]);
    expect(events.at(-1)).toEqual({ type: "done", stop_reason: "interrupted" });
  });

  it("an abort during tool execution leaves a valid history (no unpaired tool_use)", async () => {
    const controller = new AbortController();
    const { opts } = setup([toolTurn(text("checking"), toolUse("tu_1", "check_url"))], {
      ctx: { ...ctx, signal: controller.signal },
      tools: registry(
        tool("check_url", async () => {
          controller.abort();
          return "done";
        }),
      ),
    });
    const res = await runAgentLoop(opts);
    expect(res.stopReason).toBe("interrupted");
    // Tool results were recorded, so the tool_use stays paired.
    const last = res.messages.at(-1)!;
    expect(last.role).toBe("assistant");
    expect(last.content).toEqual([{ type: "text", text: "[interrupted]" }]);
    expect(res.messages[2]!.role).toBe("user");
  });
});
