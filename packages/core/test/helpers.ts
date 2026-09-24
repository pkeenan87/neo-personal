import type Anthropic from "@anthropic-ai/sdk";
import type { Message } from "@anthropic-ai/sdk/resources/messages";
import { createToolRegistry } from "../src/tool-registry.js";
import type { AgentEvent, RegisteredTool, ToolContext, ToolRegistry } from "../src/types.js";

/**
 * A fake Anthropic client for tests. No network, no API key.
 *
 * `messages.stream` / `beta.messages.stream` replay scripted turns as raw
 * stream events and resolve `finalMessage()` with the scripted Message.
 * `messages.create` (used by the compression model) returns scripted
 * responses from `createResponses`.
 */

type Block = Record<string, unknown> & { type: string };

export interface ScriptedTurn {
  content: Block[];
  stop_reason: string | null;
  stop_details?: unknown;
  usage?: Partial<Message["usage"]> & { iterations?: unknown[] };
  model?: string;
}

export type TurnScript =
  | ScriptedTurn
  | { error: unknown } // thrown before any event
  | { partialText: string; error: unknown } // one text delta, then thrown
  | { hangUntilAbort: true }; // yields nothing until the signal aborts, then returns silently (SDK behaviour)

export interface StreamCall {
  params: Record<string, unknown>;
  beta: boolean;
  signal?: AbortSignal;
}

export function makeMessage(turn: ScriptedTurn): Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: turn.model ?? "claude-opus-5",
    content: turn.content,
    stop_reason: turn.stop_reason,
    stop_sequence: null,
    stop_details: turn.stop_details ?? null,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      ...turn.usage,
    },
  } as unknown as Message;
}

function* eventsFor(message: Message): Generator<Record<string, unknown>> {
  yield { type: "message_start", message: { ...message, content: [] } };
  const content = message.content as unknown as Block[];
  for (let i = 0; i < content.length; i++) {
    const block = content[i]!;
    if (block.type === "text") {
      yield { type: "content_block_start", index: i, content_block: { type: "text", text: "" } };
      yield { type: "content_block_delta", index: i, delta: { type: "text_delta", text: block.text } };
    } else if (block.type === "thinking") {
      yield { type: "content_block_start", index: i, content_block: { type: "thinking", thinking: "", signature: "" } };
      yield { type: "content_block_delta", index: i, delta: { type: "thinking_delta", thinking: block.thinking } };
    } else {
      yield { type: "content_block_start", index: i, content_block: block };
    }
    yield { type: "content_block_stop", index: i };
  }
  yield { type: "message_delta", delta: { stop_reason: message.stop_reason }, usage: message.usage };
  yield { type: "message_stop" };
}

export interface FakeClient {
  client: Anthropic;
  streamCalls: StreamCall[];
  createCalls: Array<Record<string, unknown>>;
  /** Scripted `messages.create` responses (compression model). An Error entry is thrown. */
  createResponses: Array<Message | Error>;
  remainingTurns: () => number;
}

export function fakeClient(turns: TurnScript[]): FakeClient {
  const queue = [...turns];
  const streamCalls: StreamCall[] = [];
  const createCalls: Array<Record<string, unknown>> = [];
  const createResponses: Array<Message | Error> = [];

  function stream(params: Record<string, unknown>, options: { signal?: AbortSignal } | undefined, beta: boolean) {
    streamCalls.push({ params: JSON.parse(JSON.stringify(params)) as Record<string, unknown>, beta, signal: options?.signal });
    const turn = queue.shift();
    if (!turn) throw new Error("fakeClient: no scripted turn left");
    const signal = options?.signal;
    const message = "content" in turn ? makeMessage(turn) : undefined;

    return {
      async *[Symbol.asyncIterator]() {
        if ("hangUntilAbort" in turn) {
          await new Promise<void>((resolve) => {
            if (signal?.aborted) return resolve();
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return;
        }
        if ("error" in turn) {
          if ("partialText" in turn) {
            yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: turn.partialText } };
          }
          throw turn.error;
        }
        yield* eventsFor(message!);
      },
      async finalMessage() {
        if ("error" in turn) throw turn.error;
        if ("hangUntilAbort" in turn) throw new Error("aborted");
        return message!;
      },
    };
  }

  const client = {
    messages: {
      stream: (p: Record<string, unknown>, o?: { signal?: AbortSignal }) => stream(p, o, false),
      create: async (p: Record<string, unknown>) => {
        createCalls.push(JSON.parse(JSON.stringify(p)) as Record<string, unknown>);
        const r = createResponses.shift();
        if (!r) throw new Error("fakeClient: no scripted create response");
        if (r instanceof Error) throw r;
        return r;
      },
    },
    beta: {
      messages: {
        stream: (p: Record<string, unknown>, o?: { signal?: AbortSignal }) => stream(p, o, true),
      },
    },
  };

  return {
    client: client as unknown as Anthropic,
    streamCalls,
    createCalls,
    createResponses,
    remainingTurns: () => queue.length,
  };
}

// ── Turn builders ────────────────────────────────────────────

export const text = (t: string): Block => ({ type: "text", text: t, citations: null });
export const thinking = (t: string): Block => ({ type: "thinking", thinking: t, signature: "sig" });
export const toolUse = (id: string, name: string, input: unknown = {}): Block => ({
  type: "tool_use",
  id,
  name,
  input,
});

export const endTurn = (t = "done"): ScriptedTurn => ({ content: [text(t)], stop_reason: "end_turn" });
export const toolTurn = (...blocks: Block[]): ScriptedTurn => ({ content: blocks, stop_reason: "tool_use" });

// ── Agent fixtures ───────────────────────────────────────────

export const ctx: ToolContext = { tenantId: "tenant-1", userId: "user-1@example.com", conversationId: "conv-1" };

export function tool(
  name: string,
  execute: RegisteredTool["execute"] = async () => ({ ok: true, tool: name }),
  extra: { destructive?: boolean; description?: string } = {},
): RegisteredTool {
  return {
    definition: {
      name,
      description: extra.description ?? `The ${name} tool`,
      input_schema: { type: "object", properties: {} },
      ...(extra.destructive ? { destructive: true } : {}),
    },
    execute,
  };
}

export function registry(...tools: RegisteredTool[]): ToolRegistry {
  return createToolRegistry(tools);
}

export function collector(): { events: AgentEvent[]; onEvent: (e: AgentEvent) => void } {
  const events: AgentEvent[] = [];
  return { events, onEvent: (e) => void events.push(e) };
}
