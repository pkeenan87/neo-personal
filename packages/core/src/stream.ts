import type { AgentEvent } from "./types.js";

/** Serialize one AgentEvent as an NDJSON line (JSON + "\n"). */
export function encodeEvent(e: AgentEvent): string {
  return JSON.stringify(e) + "\n";
}

/** Parse an NDJSON line back into an AgentEvent (client side / tests). */
export function decodeEvent(line: string): AgentEvent {
  return JSON.parse(line) as AgentEvent;
}

export const NDJSON_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";

/**
 * A byte stream of NDJSON-encoded AgentEvents for a streaming HTTP response:
 *
 * ```ts
 * const { readable, send, close } = createEventStream();
 * void runAgentLoop({ ..., onEvent: send }).finally(close);
 * return new Response(readable, { headers: { "content-type": NDJSON_CONTENT_TYPE } });
 * ```
 *
 * `send` resolves once the event is queued. After the client disconnects,
 * writes are dropped silently instead of throwing into the agent loop.
 */
export function createEventStream(): {
  readable: ReadableStream<Uint8Array>;
  send: (e: AgentEvent) => Promise<void>;
  close: () => Promise<void>;
} {
  const encoder = new TextEncoder();
  const transform = new TransformStream<Uint8Array, Uint8Array>();
  const writer = transform.writable.getWriter();
  let closed = false;

  return {
    readable: transform.readable,
    async send(e) {
      if (closed) return;
      try {
        await writer.write(encoder.encode(encodeEvent(e)));
      } catch {
        closed = true;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await writer.close();
      } catch {
        // reader already cancelled
      }
    },
  };
}
