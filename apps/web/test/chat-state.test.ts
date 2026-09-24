import { describe, expect, it } from "vitest";
import {
  chatReducer,
  initialChatState,
  MAX_TOOL_TRACES,
  messagesFromStored,
  messageText,
  pendingConfirmation,
  type ChatState,
} from "@/lib/chat-state";
import type { AgentEvent } from "@/types/agent-event";

function run(events: AgentEvent[], state: ChatState = initialChatState()): ChatState {
  let s = chatReducer(state, { type: "send", userId: "u1", assistantId: "a1", text: "hi" });
  let now = 1000;
  for (const event of events) s = chatReducer(s, { type: "event", event, now: (now += 50) });
  return s;
}

describe("chat reducer", () => {
  it("coalesces text deltas and orders parts as they stream", () => {
    const s = run([
      { type: "thinking", text: "a" },
      { type: "thinking", text: "b" },
      { type: "text_delta", text: "Hel" },
      { type: "text_delta", text: "lo" },
      { type: "tool_start", id: "t1", name: "check_url", input: {} },
      { type: "tool_result", id: "t1", name: "check_url", result: 1 },
      { type: "text_delta", text: "Done" },
    ]);
    const a = s.messages[1]!;
    expect(a.parts.map((p) => p.kind)).toEqual(["thinking", "text", "tool", "text"]);
    expect(a.parts[0]).toEqual({ kind: "thinking", text: "ab" });
    expect(a.parts[2]).toMatchObject({ trace: { status: "done", result: 1, durationMs: 50 } });
    expect(messageText(a)).toBe("Hello\n\nDone");
    expect(s.streaming).toBe(true);
  });

  it("marks errored tools and error events", () => {
    const s = run([
      { type: "tool_start", id: "t1", name: "x", input: {} },
      { type: "tool_result", id: "t1", name: "x", result: "nope", is_error: true },
      { type: "error", message: "Model overloaded" },
    ]);
    expect(s.messages[1]).toMatchObject({ status: "error", error: "Model overloaded" });
    expect(s.messages[1]!.parts[0]).toMatchObject({ trace: { status: "error" } });
  });

  it("settles running tools on interrupt and finish", () => {
    const s = chatReducer(run([{ type: "tool_start", id: "t1", name: "x", input: {} }]), { type: "interrupt" });
    expect(s.streaming).toBe(false);
    expect(s.messages[1]).toMatchObject({ status: "interrupted" });
    expect(s.messages[1]!.parts[0]).toMatchObject({ trace: { status: "error" } });
  });

  it("tracks and resolves confirmations", () => {
    let s = run([{ type: "confirmation_required", id: "c1", name: "report", input: {}, description: "ok?" }]);
    s = chatReducer(s, { type: "event", event: { type: "done", stop_reason: "confirmation_required" } });
    s = chatReducer(s, { type: "finish" });
    expect(pendingConfirmation(s)?.id).toBe("c1");
    s = chatReducer(s, { type: "confirmation_status", id: "c1", status: "declined" });
    expect(pendingConfirmation(s)).toBeNull();
  });

  it("accumulates usage and caps tool traces", () => {
    const events: AgentEvent[] = [
      { type: "usage", input_tokens: 1, output_tokens: 2 },
      { type: "usage", input_tokens: 3, output_tokens: 4 },
    ];
    for (let i = 0; i < MAX_TOOL_TRACES + 5; i++) events.push({ type: "tool_start", id: `t${i}`, name: "x", input: {} });
    const a = run(events).messages[1]!;
    expect(a.usage).toEqual({ input_tokens: 4, output_tokens: 6 });
    expect(a.parts.filter((p) => p.kind === "tool")).toHaveLength(MAX_TOOL_TRACES);
  });
});

describe("messagesFromStored", () => {
  it("merges tool-use turns into one assistant message and skips plumbing", () => {
    const msgs = messagesFromStored([
      { role: "user", content: [{ type: "text", text: "check it" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "…", signature: "x" },
          { type: "text", text: "Checking." },
          { type: "tool_use", id: "t1", name: "check_url", input: { url: "u" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "bad", is_error: true }] },
      { role: "assistant", content: "Result." },
      { role: "user", content: "thanks" },
    ]);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(msgs[1]!.parts.map((p) => p.kind)).toEqual(["text", "tool", "text"]);
    expect(msgs[1]!.parts[1]).toMatchObject({ trace: { id: "t1", status: "error", result: "bad" } });
    expect(messageText(msgs[2]!)).toBe("thanks");
  });
});
