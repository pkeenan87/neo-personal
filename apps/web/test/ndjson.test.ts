import { describe, expect, it } from "vitest";
import { createNdjsonDecoder, isAgentEvent, parseEventLine, readAgentEvents } from "@/lib/ndjson";
import type { AgentEvent } from "@/types/agent-event";
import { collect, ndjson, streamingResponse } from "./fixtures";

const EVENTS: AgentEvent[] = [
  { type: "thinking", text: "hmm" },
  { type: "text_delta", text: "Hello " },
  { type: "text_delta", text: "wörld 🌍" },
  { type: "tool_start", id: "t1", name: "check_url", input: { url: "https://x.test" } },
  { type: "tool_result", id: "t1", name: "check_url", result: { ok: true }, is_error: false },
  { type: "confirmation_required", id: "c1", name: "report_phish", input: {}, description: "Report it" },
  { type: "usage", input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 },
  { type: "done", stop_reason: "end_turn" },
  { type: "error", message: "boom" },
];

describe("NDJSON AgentEvent parser", () => {
  it("round-trips every AgentEvent type through a chunked byte stream", async () => {
    const res = streamingResponse(ndjson(EVENTS), {}, 5); // 5-byte chunks split lines and multi-byte chars
    expect(await collect(readAgentEvents(res.body!))).toEqual(EVENTS);
  });

  it("parses a trailing line with no newline on flush", () => {
    const dec = createNdjsonDecoder();
    expect(dec.push('{"type":"text_delta","text":"a"}\n{"type":"done","stop_')).toEqual([
      { type: "text_delta", text: "a" },
    ]);
    expect(dec.push('reason":"end_turn"}')).toEqual([]);
    expect(dec.flush()).toEqual([{ type: "done", stop_reason: "end_turn" }]);
  });

  it("skips blank, malformed, unknown, and ill-shaped lines without aborting", async () => {
    const text = [
      "",
      "   ",
      "not json",
      '{"type":"text_delta","text":"ok"}',
      '{"type":"mystery","x":1}',
      '{"type":"text_delta","text":42}',
      '{"type":"tool_start","name":"x"}',
      "[1,2,3]",
      '{"type":"done","stop_reason":"end_turn"}',
      "",
    ].join("\r\n");
    const events = await collect(readAgentEvents(streamingResponse(text).body!));
    expect(events).toEqual([
      { type: "text_delta", text: "ok" },
      { type: "done", stop_reason: "end_turn" },
    ]);
  });

  it("validates event shapes", () => {
    expect(isAgentEvent({ type: "usage", input_tokens: 1, output_tokens: 2 })).toBe(true);
    expect(isAgentEvent({ type: "usage", input_tokens: "1", output_tokens: 2 })).toBe(false);
    expect(isAgentEvent({ type: "tool_result", id: "a", name: "b", result: null, is_error: "yes" })).toBe(false);
    expect(isAgentEvent({ type: "confirmation_required", id: "a", name: "b", input: {} })).toBe(false);
    expect(parseEventLine('{"type":"error","message":"x"}')).toEqual({ type: "error", message: "x" });
    expect(parseEventLine("{")).toBeNull();
  });
});
