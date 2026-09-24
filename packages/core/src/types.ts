import type Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";

// ─────────────────────────────────────────────────────────────
//  Tool registry
// ─────────────────────────────────────────────────────────────

/**
 * A tool the agent may call. Everything in the registry is allowed;
 * `destructive: true` tools pause the loop for explicit user confirmation
 * before they run (see `runAgentLoop` / `resumeAfterConfirmation`).
 */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool input (must be `type: "object"`). */
  input_schema: Record<string, unknown>;
  destructive?: boolean;
  /** Opt into strict tool use (schema-guaranteed arguments). */
  strict?: boolean;
}

export type ToolContext = {
  tenantId: string;
  userId: string;
  conversationId: string;
  signal?: AbortSignal;
};

export type ToolExecutor = (input: unknown, ctx: ToolContext) => Promise<unknown>;

export interface RegisteredTool {
  definition: ToolDefinition;
  execute: ToolExecutor;
}

export interface ToolRegistry {
  /** Definitions sorted by name (deterministic order keeps the prompt cache stable). */
  list(): ToolDefinition[];
  get(name: string): RegisteredTool | undefined;
}

// ─────────────────────────────────────────────────────────────
//  Agent loop
// ─────────────────────────────────────────────────────────────

/** NDJSON events streamed to clients. */
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

export type Effort = "low" | "medium" | "high";

export interface RunAgentOptions {
  messages: MessageParam[];
  system: string;
  tools: ToolRegistry;
  ctx: ToolContext;
  /** Default: env `NEO_AGENT_MODEL` or `claude-opus-5`. */
  model?: string;
  /** Default: `medium`. Sent as `output_config.effort`. */
  effort?: Effort;
  /** Default: 16000. Caps thinking + visible output per API call. */
  maxTokens?: number;
  onEvent: (e: AgentEvent) => void | Promise<void>;

  // ── Additive options (not in docs/contracts.md; all optional) ──
  /** Inject an Anthropic client (tests, custom base URL). Default: `new Anthropic()` from env. */
  client?: Anthropic;
  /** Override server-side refusal fallbacks. Default: env `NEO_ENABLE_FALLBACKS` (true). */
  enableFallbacks?: boolean;
  /** Upper bound on model calls in one run (tool-use iterations). Default 20. */
  maxIterations?: number;
  /** Retry tuning for 429 / 5xx / 529. Default: 2 retries, 1000 ms base backoff. */
  retry?: { maxRetries?: number; baseDelayMs?: number };
}

export interface AgentUsage {
  /** Uncached input tokens (API `usage.input_tokens`), summed across model calls. */
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface PendingConfirmation {
  id: string;
  name: string;
  input: unknown;
}

export interface AgentResult {
  /** Full conversation after this run (input messages + everything appended). */
  messages: MessageParam[];
  pendingConfirmation?: PendingConfirmation;
  usage: AgentUsage;

  // ── Additive fields (not in docs/contracts.md) ──
  /** Only the messages appended during this run (for `ConversationStore.appendTurn`). */
  newMessages: MessageParam[];
  /**
   * Why the run ended: an API stop_reason (`end_turn`, `max_tokens`, `refusal`, ...)
   * or one of `confirmation_required`, `interrupted`, `error`, `max_iterations`.
   */
  stopReason: string;
  /** User-safe error message when `stopReason` is `error` / `refusal`. */
  error?: string;
}

// ─────────────────────────────────────────────────────────────
//  Safeguards
// ─────────────────────────────────────────────────────────────

export interface ScanResult {
  flagged: boolean;
  /** Label of the first matching pattern. */
  label?: string;
  matchCount: number;
  /** Labels of every matching pattern. */
  labels: string[];
}

// ─────────────────────────────────────────────────────────────
//  Persistence interface (implemented by @neo/db)
// ─────────────────────────────────────────────────────────────

export interface ConversationStore {
  create(input: { tenantId: string; userId: string; title?: string }): Promise<{ id: string }>;
  get(
    id: string,
    tenantId: string,
  ): Promise<{ id: string; messages: MessageParam[]; pendingConfirmation?: unknown } | undefined>;
  appendTurn(
    id: string,
    tenantId: string,
    turn: {
      messages: MessageParam[];
      usage?: { input_tokens: number; output_tokens: number };
      pendingConfirmation?: unknown | null;
    },
  ): Promise<void>;
  list(tenantId: string, userId: string): Promise<Array<{ id: string; title: string | null; updatedAt: Date }>>;
  delete(id: string, tenantId: string): Promise<void>;
}
