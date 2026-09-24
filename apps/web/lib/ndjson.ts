/**
 * NDJSON → AgentEvent parsing. Runs in the browser (and in tests).
 * One JSON object per line; blank lines ignored; malformed lines and
 * unknown/ill-shaped events are skipped rather than aborting the stream,
 * so a single bad line never kills a response.
 */
import type { AgentEvent } from "@/types/agent-event";

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const str = (v: unknown): v is string => typeof v === "string";
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const optNum = (v: unknown) => v === undefined || num(v);

/** Runtime guard for the AgentEvent union (docs/contracts.md). */
export function isAgentEvent(v: unknown): v is AgentEvent {
  if (!isObj(v) || !str(v.type)) return false;
  switch (v.type) {
    case "text_delta":
    case "thinking":
      return str(v.text);
    case "tool_start":
      return str(v.id) && str(v.name) && "input" in v;
    case "tool_result":
      return str(v.id) && str(v.name) && (v.is_error === undefined || typeof v.is_error === "boolean");
    case "confirmation_required":
      return str(v.id) && str(v.name) && str(v.description);
    case "usage":
      return (
        num(v.input_tokens) &&
        num(v.output_tokens) &&
        optNum(v.cache_read_input_tokens) &&
        optNum(v.cache_creation_input_tokens)
      );
    case "done":
      return str(v.stop_reason);
    case "error":
      return str(v.message);
    default:
      return false;
  }
}

/** Parse one NDJSON line. Returns null for blank, malformed, or non-AgentEvent lines. */
export function parseEventLine(line: string): AgentEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isAgentEvent(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Incremental decoder: feed it arbitrary byte chunks, get back the
 * complete events they finish. Call `flush()` at end of stream to parse
 * a trailing line that had no newline.
 */
export function createNdjsonDecoder() {
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    push(chunk: Uint8Array | string): AgentEvent[] {
      buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      const out: AgentEvent[] = [];
      for (const line of lines) {
        const e = parseEventLine(line);
        if (e) out.push(e);
      }
      return out;
    },
    flush(): AgentEvent[] {
      buffer += decoder.decode();
      const rest = buffer;
      buffer = "";
      const e = parseEventLine(rest);
      return e ? [e] : [];
    },
  };
}

/** Async-iterate the AgentEvents in an NDJSON byte stream. */
export async function* readAgentEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<AgentEvent> {
  const reader = stream.getReader();
  const dec = createNdjsonDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield* dec.push(value);
    }
    yield* dec.flush();
  } finally {
    reader.releaseLock();
  }
}
