import { describe, expect, it } from "vitest";
import { createEventStream, decodeEvent, encodeEvent } from "../src/stream.js";
import { createToolRegistry } from "../src/tool-registry.js";
import type { AgentEvent } from "../src/types.js";
import { tool } from "./helpers.js";

describe("encodeEvent", () => {
  it("encodes one event per line", () => {
    const e: AgentEvent = { type: "text_delta", text: "line one\nline two" };
    const line = encodeEvent(e);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1).includes("\n")).toBe(false);
    expect(decodeEvent(line)).toEqual(e);
  });
});

describe("createEventStream", () => {
  it("streams NDJSON bytes that decode back to the events", async () => {
    const { readable, send, close } = createEventStream();
    const events: AgentEvent[] = [
      { type: "text_delta", text: "hi" },
      { type: "done", stop_reason: "end_turn" },
    ];
    const reading = new Response(readable).text();
    for (const e of events) await send(e);
    await close();
    const body = await reading;
    expect(body.trim().split("\n").map(decodeEvent)).toEqual(events);
  });

  it("drops writes after the reader cancels instead of throwing", async () => {
    const { readable, send } = createEventStream();
    await readable.cancel();
    await expect(send({ type: "text_delta", text: "x" })).resolves.toBeUndefined();
  });
});

describe("createToolRegistry", () => {
  it("lists definitions sorted by name and looks tools up by name", () => {
    const r = createToolRegistry([tool("zeta"), tool("alpha", undefined, { destructive: true })]);
    expect(r.list().map((d) => d.name)).toEqual(["alpha", "zeta"]);
    expect(r.get("alpha")?.definition.destructive).toBe(true);
    expect(r.get("missing")).toBeUndefined();
  });

  it("returns a copy from list()", () => {
    const r = createToolRegistry([tool("a")]);
    r.list().pop();
    expect(r.list()).toHaveLength(1);
  });

  it("rejects duplicate names, invalid names and non-object schemas", () => {
    expect(() => createToolRegistry([tool("a"), tool("a")])).toThrow(/Duplicate/);
    expect(() => createToolRegistry([tool("bad name!")])).toThrow(/Invalid tool name/);
    const t = tool("s");
    t.definition.input_schema = { type: "string" };
    expect(() => createToolRegistry([t])).toThrow(/type "object"/);
  });
});
