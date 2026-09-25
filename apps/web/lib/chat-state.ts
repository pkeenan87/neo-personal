/**
 * Pure chat state: applies AgentEvents to a list of chat messages and
 * rebuilds that list from persisted Anthropic-style messages. Kept free of
 * React so it can be unit-tested and reused by the mobile/desktop shells.
 *
 * AgentEvent → UI mapping (Neo's old events in brackets):
 *   text_delta            → append to the streaming assistant text part   [response]
 *   thinking              → append to a collapsible "thinking" part        [thinking]
 *   tool_start            → push a running ToolTrace part                  [tool_call]
 *   tool_result           → complete the matching ToolTrace by id          [tool_result]
 *   confirmation_required → push a pending ConfirmationPrompt part         [confirmation_required]
 *   usage                 → recorded on the message (not rendered)
 *   done                  → mark the message complete                     [—]
 *   error                 → mark the message errored with the text         [error]
 */
import type { AgentEvent } from "@neo/core";
import { isHiddenContextText } from "./hidden-context";
import { stripPlaybookMarker } from "./playbooks";

export type ToolStatus = "running" | "done" | "error";

export interface ToolTrace {
  id: string;
  name: string;
  input: unknown;
  result?: unknown;
  status: ToolStatus;
  startedAt?: number;
  durationMs?: number;
}

export type ConfirmationStatus = "pending" | "submitting" | "approved" | "declined";

export interface ConfirmationRequest {
  id: string;
  name: string;
  input: unknown;
  description: string;
  status: ConfirmationStatus;
}

export type MessagePart =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; trace: ToolTrace }
  | { kind: "confirmation"; confirmation: ConfirmationRequest };

export type MessageStatus = "streaming" | "complete" | "interrupted" | "error";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  parts: MessagePart[];
  status: MessageStatus;
  error?: string;
  stopReason?: string;
  usage?: { input_tokens: number; output_tokens: number };
}

export interface ChatState {
  messages: ChatMessage[];
  streaming: boolean;
}

export type ChatAction =
  | { type: "send"; userId: string; assistantId: string; text: string }
  | { type: "resume"; assistantId: string }
  | { type: "event"; event: AgentEvent; now?: number }
  | { type: "finish" }
  | { type: "interrupt" }
  | { type: "fail"; message: string }
  | { type: "confirmation_status"; id: string; status: ConfirmationStatus }
  | { type: "reset"; messages: ChatMessage[] };

/** Bound runaway turns: never keep more than this many tool traces per message. */
export const MAX_TOOL_TRACES = 50;

export function initialChatState(messages: ChatMessage[] = []): ChatState {
  return { messages, streaming: false };
}

function updateLastAssistant(state: ChatState, fn: (m: ChatMessage) => ChatMessage): ChatState {
  const idx = state.messages.length - 1;
  const last = state.messages[idx];
  if (!last || last.role !== "assistant") return state;
  const messages = state.messages.slice();
  messages[idx] = fn(last);
  return { ...state, messages };
}

function appendText(parts: MessagePart[], kind: "text" | "thinking", text: string): MessagePart[] {
  const last = parts[parts.length - 1];
  if (last && last.kind === kind) {
    return [...parts.slice(0, -1), { kind, text: last.text + text }];
  }
  return [...parts, { kind, text }];
}

function applyEvent(m: ChatMessage, e: AgentEvent, now: number): ChatMessage {
  switch (e.type) {
    case "text_delta":
      return { ...m, parts: appendText(m.parts, "text", e.text) };
    case "thinking":
      return { ...m, parts: appendText(m.parts, "thinking", e.text) };
    case "tool_start": {
      const count = m.parts.filter((p) => p.kind === "tool").length;
      if (count >= MAX_TOOL_TRACES) return m;
      const trace: ToolTrace = { id: e.id, name: e.name, input: e.input, status: "running", startedAt: now };
      return { ...m, parts: [...m.parts, { kind: "tool", trace }] };
    }
    case "tool_result": {
      let found = false;
      const parts = m.parts.map((p): MessagePart => {
        if (p.kind !== "tool" || p.trace.id !== e.id) return p;
        found = true;
        return {
          kind: "tool",
          trace: {
            ...p.trace,
            result: e.result,
            status: e.is_error ? "error" : "done",
            durationMs: p.trace.startedAt !== undefined ? Math.max(0, now - p.trace.startedAt) : undefined,
          },
        };
      });
      if (!found) {
        // Result without a start (e.g. resumed after confirmation): still show it.
        parts.push({
          kind: "tool",
          trace: { id: e.id, name: e.name, input: undefined, result: e.result, status: e.is_error ? "error" : "done" },
        });
      }
      return { ...m, parts };
    }
    case "confirmation_required":
      return {
        ...m,
        parts: [
          ...m.parts,
          {
            kind: "confirmation",
            confirmation: { id: e.id, name: e.name, input: e.input, description: e.description, status: "pending" },
          },
        ],
      };
    case "usage":
      return {
        ...m,
        usage: {
          input_tokens: (m.usage?.input_tokens ?? 0) + e.input_tokens,
          output_tokens: (m.usage?.output_tokens ?? 0) + e.output_tokens,
        },
      };
    case "done":
      return { ...m, status: m.status === "streaming" ? "complete" : m.status, stopReason: e.stop_reason };
    case "error":
      return { ...m, status: "error", error: e.message };
  }
}

/** Any tool still marked running when a stream ends is shown as stopped, not spinning forever. */
function settleRunningTools(m: ChatMessage): ChatMessage {
  if (!m.parts.some((p) => p.kind === "tool" && p.trace.status === "running")) return m;
  return {
    ...m,
    parts: m.parts.map((p) =>
      p.kind === "tool" && p.trace.status === "running" ? { kind: "tool", trace: { ...p.trace, status: "error" } } : p,
    ),
  };
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "send":
      return {
        streaming: true,
        messages: [
          ...state.messages,
          { id: action.userId, role: "user", parts: [{ kind: "text", text: action.text }], status: "complete" },
          { id: action.assistantId, role: "assistant", parts: [], status: "streaming" },
        ],
      };
    case "resume":
      return {
        streaming: true,
        messages: [...state.messages, { id: action.assistantId, role: "assistant", parts: [], status: "streaming" }],
      };
    case "event":
      return updateLastAssistant(state, (m) => applyEvent(m, action.event, action.now ?? Date.now()));
    case "finish": {
      const next = updateLastAssistant(state, (m) =>
        settleRunningTools({ ...m, status: m.status === "streaming" ? "complete" : m.status }),
      );
      return { ...next, streaming: false };
    }
    case "interrupt": {
      const next = updateLastAssistant(state, (m) =>
        settleRunningTools({ ...m, status: m.status === "streaming" ? "interrupted" : m.status }),
      );
      return { ...next, streaming: false };
    }
    case "fail": {
      const next = updateLastAssistant(state, (m) => settleRunningTools({ ...m, status: "error", error: action.message }));
      return { ...next, streaming: false };
    }
    case "confirmation_status":
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.parts.some((p) => p.kind === "confirmation" && p.confirmation.id === action.id)
            ? {
                ...m,
                parts: m.parts.map((p) =>
                  p.kind === "confirmation" && p.confirmation.id === action.id
                    ? { kind: "confirmation", confirmation: { ...p.confirmation, status: action.status } }
                    : p,
                ),
              }
            : m,
        ),
      };
    case "reset":
      return initialChatState(action.messages);
  }
}

/** The confirmation currently awaiting a decision, if any. */
export function pendingConfirmation(state: ChatState): ConfirmationRequest | null {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i];
    if (!m) continue;
    for (const p of m.parts) {
      if (p.kind === "confirmation" && (p.confirmation.status === "pending" || p.confirmation.status === "submitting")) {
        return p.confirmation;
      }
    }
  }
  return null;
}

/** Concatenated visible text of a message (used for copy). */
export function messageText(m: ChatMessage): string {
  return m.parts
    .filter((p): p is { kind: "text"; text: string } => p.kind === "text")
    .map((p) => stripPlaybookMarker(p.text))
    .join("\n\n")
    .trim();
}

// ─── Hydration from persisted messages ──────────────────────────────

/**
 * Minimal structural view of an Anthropic `MessageParam` as stored by
 * ConversationStore. Real `MessageParam[]` values are assignable to this.
 */
export interface StoredMessage {
  role: "user" | "assistant";
  content: string | ReadonlyArray<StoredBlock>;
}
export type StoredBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content?: unknown; is_error?: boolean }
  | { type: string; [k: string]: unknown };

export interface StoredPendingConfirmation {
  id: string;
  name: string;
  input: unknown;
  description?: string;
}

function blocks(content: StoredMessage["content"]): StoredBlock[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : [...content];
}

function isToolResultOnly(msg: StoredMessage): boolean {
  return Array.isArray(msg.content) && msg.content.length > 0 && msg.content.every((b) => b.type === "tool_result");
}

/**
 * Rebuild chat messages from persisted turns. Consecutive assistant turns
 * separated only by tool_result carrier messages are merged into one chat
 * message so a reloaded conversation looks like the live stream: text,
 * tool traces, then the final answer.
 */
export function messagesFromStored(
  stored: ReadonlyArray<StoredMessage>,
  opts: { pending?: StoredPendingConfirmation | null; idPrefix?: string } = {},
): ChatMessage[] {
  const out: ChatMessage[] = [];
  const prefix = opts.idPrefix ?? "h";
  let n = 0;
  const nextId = () => `${prefix}-${n++}`;
  let current: ChatMessage | null = null;

  const closeCurrent = () => {
    if (current && current.parts.length > 0) out.push(current);
    current = null;
  };

  for (const msg of stored) {
    if (msg.role === "user" && isToolResultOnly(msg)) {
      if (!current) continue;
      const cur: ChatMessage = current;
      for (const b of blocks(msg.content)) {
        if (b.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
        const isError = b.is_error === true;
        cur.parts = cur.parts.map((p) =>
          p.kind === "tool" && p.trace.id === b.tool_use_id
            ? { kind: "tool", trace: { ...p.trace, result: b.content, status: isError ? "error" : "done" } }
            : p,
        );
      }
      continue;
    }

    if (msg.role === "user") {
      closeCurrent();
      const text = blocks(msg.content)
        .filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .filter((t) => !isHiddenContextText(t)) // server-added context (agent E: "Ask Neo about this")
        .join("\n");
      if (text.trim()) out.push({ id: nextId(), role: "user", parts: [{ kind: "text", text }], status: "complete" });
      continue;
    }

    // assistant
    if (!current) current = { id: nextId(), role: "assistant", parts: [], status: "complete" };
    const cur: ChatMessage = current;
    for (const b of blocks(msg.content)) {
      if (b.type === "text" && typeof b.text === "string") {
        if (b.text) cur.parts = appendText(cur.parts, "text", cur.parts.at(-1)?.kind === "text" ? `\n\n${b.text}` : b.text);
      } else if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
        cur.parts = [...cur.parts, { kind: "tool", trace: { id: b.id, name: b.name, input: b.input, status: "done" } }];
      }
      // thinking / redacted_thinking / other blocks are not shown on reload.
    }
  }

  const pending = opts.pending;
  if (pending) {
    if (!current) current = { id: nextId(), role: "assistant", parts: [], status: "complete" };
    const cur: ChatMessage = current;
    cur.parts = [
      ...cur.parts,
      {
        kind: "confirmation",
        confirmation: {
          id: pending.id,
          name: pending.name,
          input: pending.input,
          description: pending.description ?? `Neo wants to run ${pending.name}.`,
          status: "pending",
        },
      },
    ];
  }
  closeCurrent();
  return out;
}
