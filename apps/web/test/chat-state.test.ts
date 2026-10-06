import { describe, expect, it } from "vitest";
import {
  chatReducer,
  initialChatState,
  MAX_TOOL_TRACES,
  messagesFromStored,
  messageText,
  pendingConfirmation,
  type ChatEvent,
  type ChatState,
  type RouteEvent,
} from "@/lib/chat-state";
import type { Route } from "@neo/core";
import { splitVerdictSegments } from "@/lib/verdict-fence";
import { VERDICT_FIXTURE } from "./fixtures";

function run(events: ChatEvent[], state: ChatState = initialChatState()): ChatState {
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
    const events: ChatEvent[] = [
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

// ─── Phase 2: model routing (_specs/model-routing.md) ───

const routeEvent: RouteEvent = {
  type: "route",
  model: "anthropic/claude-sonnet-5",
  displayName: "Sonnet 5",
  tier: "medium",
  effort: "medium",
  family: "anthropic",
  preference: "balanced",
  router: "jev",
  reason: "Jev: complexity 1/2, stakes 0/2",
};

const storedRoute: Route = {
  tier: "large",
  family: "anthropic",
  model: "anthropic/claude-opus-5",
  displayName: "Opus 5",
  effort: "high",
  preference: "balanced",
  router: "pinned",
  signals: { reason: "Playbook" },
};

describe("chat reducer: route and served model", () => {
  it("stores a route event that arrives before any text on the assistant message", () => {
    const s = run([routeEvent, { type: "text_delta", text: "Hi" }, { type: "done", stop_reason: "end_turn" }]);
    const a = s.messages[1]!;
    expect(a.role).toBe("assistant");
    expect(a.route).toEqual({
      tier: "medium",
      family: "anthropic",
      model: "anthropic/claude-sonnet-5",
      displayName: "Sonnet 5",
      effort: "medium",
      preference: "balanced",
      router: "jev",
      signals: { reason: "Jev: complexity 1/2, stakes 0/2" },
    });
    expect(messageText(a)).toBe("Hi");
  });

  it("stores a route event that arrives after text without touching the parts", () => {
    const s = run([{ type: "text_delta", text: "Hi" }, { ...routeEvent, reason: undefined, router: "rule" }]);
    const a = s.messages[1]!;
    expect(a.route).toMatchObject({ model: "anthropic/claude-sonnet-5", router: "rule" });
    expect(a.route?.signals).toBeUndefined();
    expect(a.parts).toEqual([{ kind: "text", text: "Hi" }]);
  });

  it("records usage.model as the served model and keeps summing tokens", () => {
    const s = run([
      routeEvent,
      { type: "usage", input_tokens: 1, output_tokens: 2 },
      { type: "usage", input_tokens: 3, output_tokens: 4, model: "claude-sonnet-5-20260901" },
    ]);
    const a = s.messages[1]!;
    expect(a.usage).toEqual({ input_tokens: 4, output_tokens: 6 });
    expect(a.servedModel).toBe("claude-sonnet-5-20260901");
  });

  it("leaves servedModel unset when usage carries no model", () => {
    const a = run([{ type: "usage", input_tokens: 1, output_tokens: 2 }]).messages[1]!;
    expect(a.servedModel).toBeUndefined();
    expect(a.route).toBeUndefined();
  });
});

describe("messagesFromStored: per-turn routes", () => {
  it("attaches each stored turn's route to the assistant message of that turn", () => {
    const msgs = messagesFromStored([
      { messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "Hi." }] },
      {
        messages: [
          { role: "user", content: "run the playbook" },
          { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "check_url", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
          { role: "assistant", content: "Done." },
        ],
        route: storedRoute,
      },
    ]);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(msgs[1]!.route).toBeUndefined();
    expect(msgs[3]!.route).toEqual(storedRoute);
    expect(msgs[2]!.route).toBeUndefined();
  });

  it("still accepts bare messages mixed with turns", () => {
    const msgs = messagesFromStored([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { messages: [{ role: "user", content: "c" }, { role: "assistant", content: "d" }], route: null },
    ]);
    expect(msgs).toHaveLength(4);
    expect(msgs.every((m) => m.route === undefined)).toBe(true);
  });
});

describe("verdict_override", () => {
  const block = (v: object) => `\`\`\`verdict\n${JSON.stringify(v, null, 2)}\n\`\`\``;
  const card = (s: ChatState) => {
    const text = (s.messages[1]!.parts.filter((p) => p.kind === "text") as { text: string }[]).map((p) => p.text).join("\n");
    return splitVerdictSegments(text).find((x) => x.kind === "verdict");
  };

  it("swaps the card the model streamed for the server's verdict, even after done", () => {
    const safe = { ...VERDICT_FIXTURE, verdict: "likely_safe" as const, headline: "Model says fine" };
    const overridden = { ...VERDICT_FIXTURE, verdict: "malicious" as const, headline: "Rule says fake" };
    const live = run([
      { type: "text_delta", text: `Looks good.\n\n${block(safe)}` },
      { type: "done", stop_reason: "end_turn" },
    ]);
    expect(card(live)).toMatchObject({ verdict: { verdict: "likely_safe" } });
    let s = chatReducer(live, { type: "event", event: { type: "verdict_override", verdict: overridden } });
    expect(card(s)).toMatchObject({ verdict: { verdict: "malicious", headline: "Rule says fake" } });
    expect(s.messages[1]!.status).toBe("complete");
    // the surrounding text and a later note are kept
    s = chatReducer(s, { type: "event", event: { type: "text_delta", text: "\n\nA note." } });
    expect(messageText(s.messages[1]!)).toContain("Looks good.");
    expect(messageText(s.messages[1]!)).toContain("A note.");
    expect(card(s)).toMatchObject({ verdict: { verdict: "malicious" } });
  });

  it("rewrites only the last verdict block and skips text parts without one", () => {
    const first = { ...VERDICT_FIXTURE, headline: "First" };
    const last = { ...VERDICT_FIXTURE, headline: "Last" };
    const s = run([
      { type: "text_delta", text: block(first) },
      { type: "tool_start", id: "t", name: "check_url", input: {} },
      { type: "tool_result", id: "t", name: "check_url", result: 1 },
      { type: "text_delta", text: `Done.\n\n${block(last)}\n\nBye.` },
      { type: "text_delta", text: "" },
      { type: "verdict_override", verdict: { ...VERDICT_FIXTURE, headline: "Override" } },
    ]);
    const heads = (s.messages[1]!.parts.filter((p) => p.kind === "text") as { text: string }[]).flatMap((p) => splitVerdictSegments(p.text).flatMap((x) => (x.kind === "verdict" ? [x.verdict.headline] : [])));
    expect(heads).toEqual(["First", "Override"]);
  });

  it("is a no-op when no text part has a valid verdict block", () => {
    const s = run([{ type: "text_delta", text: "No card here." }, { type: "verdict_override", verdict: VERDICT_FIXTURE }]);
    expect(messageText(s.messages[1]!)).toBe("No card here.");
  });

  it("ignores a verdict block inside another code block", () => {
    const text = `~~~\n${block(VERDICT_FIXTURE)}\n~~~`;
    const s = run([{ type: "text_delta", text }, { type: "verdict_override", verdict: { ...VERDICT_FIXTURE, headline: "Nope" } }]);
    expect(messageText(s.messages[1]!)).toBe(text);
  });
});
