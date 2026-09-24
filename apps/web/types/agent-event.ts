/**
 * TEMPORARY MIRROR of `AgentEvent` from `@neo/core` (docs/contracts.md).
 *
 * The integration pass deletes this file and replaces imports of
 * `@/types/agent-event` with `import type { AgentEvent } from "@neo/core"`.
 * Do not add event types here: change docs/contracts.md and @neo/core first.
 */
export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; result: unknown; is_error?: boolean }
  | { type: "confirmation_required"; id: string; name: string; input: unknown; description: string }
  | {
      type: "usage";
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    }
  | { type: "done"; stop_reason: string }
  | { type: "error"; message: string };

export type AgentEventType = AgentEvent["type"];

/** Encode one event as an NDJSON line. TEMPORARY: replaced by `encodeEvent` from @neo/core. */
export function encodeEvent(e: AgentEvent): string {
  return JSON.stringify(e) + "\n";
}
