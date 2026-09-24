import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type {
  ContentBlockParam,
  Message,
  MessageCreateParamsBase,
  MessageParam,
  RawMessageStreamEvent,
  TextBlockParam,
  Tool,
  ToolResultBlockParam,
  ToolUseBlockParam,
} from "@anthropic-ai/sdk/resources/messages";
import {
  CHARS_PER_TOKEN,
  DEFAULT_EFFORT,
  DEFAULT_MAX_TOKENS,
  SERVER_SIDE_FALLBACK_BETA,
  agentModel,
  fallbacksEnabled,
} from "./config.js";
import { mergeConsecutiveUserMessages, prepareMessages } from "./context-manager.js";
import { wrapToolResult } from "./injection-guard.js";
import { hashPii, logger } from "./logger.js";
import type {
  AgentEvent,
  AgentResult,
  AgentUsage,
  PendingConfirmation,
  RegisteredTool,
  RunAgentOptions,
  ToolDefinition,
} from "./types.js";

/**
 * The agent loop, lifted from Neo's `web/lib/agent.ts` and modernised:
 *
 *  - streams every call with `messages.stream()` (or `beta.messages.stream()`
 *    when server-side refusal fallbacks are on) and forwards text / thinking
 *    deltas as AgentEvents; `finalMessage()` yields the complete Message,
 *  - adaptive thinking with summarised display, depth via `output_config.effort`,
 *  - prompt caching: breakpoints on the last tool, the system prompt, and the
 *    last message block; nothing volatile precedes them,
 *  - parallel tool calls: every tool_use in one assistant message runs, and
 *    all tool_results go back in one user message (failed tools: is_error),
 *  - every tool result passes through `wrapToolResult`,
 *  - `destructive: true` tools pause the loop for user confirmation,
 *  - `refusal` stop reasons end the turn with a user-safe error,
 *  - retries on 429 / 5xx / 529 / overloaded (only before any delta was
 *    forwarded, so the client never sees duplicated text).
 *
 * The loop is manual (not the SDK tool runner) because the confirmation gate
 * must suspend the run across HTTP requests and resume from persisted state.
 */

const COMPONENT = "agent";
const DEFAULT_MAX_ITERATIONS = 20;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 8000;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);
const RETRYABLE_STREAM_ERROR_TYPES = new Set(["overloaded_error", "api_error", "rate_limit_error"]);

export const REFUSAL_MESSAGE =
  "Claude declined to answer this request under its safety policies. " +
  "If this was a legitimate security question, try rephrasing it with more context about what you're protecting.";
const MAX_TOKENS_TOOL_MESSAGE =
  "The response hit its length limit before a tool call was complete, so the tool was not run. Please try again or ask a narrower question.";
const MAX_ITERATIONS_MESSAGE =
  "Neo stopped after too many steps in one turn. Please narrow the request and try again.";
const CONTEXT_EXCEEDED_MESSAGE =
  "This conversation has grown too long for the model. Please start a new conversation.";
const STALE_CONFIRMATION_MESSAGE =
  "This confirmation is no longer valid for this conversation. Please ask again.";

let defaultClient: Anthropic | undefined;
function getClient(opts: RunAgentOptions): Anthropic {
  if (opts.client) return opts.client;
  defaultClient ??= new Anthropic();
  return defaultClient;
}

// ─────────────────────────────────────────────────────────────
//  Request building
// ─────────────────────────────────────────────────────────────

/** Anthropic tools from the registry, cache breakpoint on the last one. */
export function buildTools(definitions: readonly ToolDefinition[]): Tool[] {
  return definitions.map((d, i): Tool => {
    const tool: Tool = {
      name: d.name,
      description: d.description,
      input_schema: d.input_schema as Tool["input_schema"],
      ...(d.strict ? { strict: true } : {}),
    };
    if (i === definitions.length - 1) tool.cache_control = { type: "ephemeral" };
    return tool;
  });
}

type CacheableBlock = ContentBlockParam & { cache_control?: unknown };
const CACHEABLE_TYPES = new Set(["text", "image", "document", "tool_use", "tool_result", "search_result"]);

/**
 * Put a cache breakpoint on the last block of the last message (after
 * removing any stray breakpoints elsewhere, so the request never exceeds the
 * 4-breakpoint limit). Returns new objects; the input is not mutated.
 */
export function stampCacheBreakpoint(messages: readonly MessageParam[]): MessageParam[] {
  const cleaned = messages.map((m): MessageParam => {
    if (typeof m.content === "string") return m;
    if (!m.content.some((b) => (b as CacheableBlock).cache_control)) return m;
    return {
      ...m,
      content: m.content.map((b) => {
        if (!(b as CacheableBlock).cache_control) return b;
        const { cache_control: _drop, ...rest } = b as CacheableBlock;
        return rest as ContentBlockParam;
      }),
    };
  });
  const last = cleaned[cleaned.length - 1];
  if (!last) return cleaned;
  let content: ContentBlockParam[];
  if (typeof last.content === "string") {
    if (last.content.length === 0) return cleaned;
    content = [{ type: "text", text: last.content }];
  } else {
    content = [...last.content];
  }
  const idx = content.length - 1;
  const block = content[idx];
  if (!block || !CACHEABLE_TYPES.has(block.type)) return cleaned;
  content[idx] = { ...block, cache_control: { type: "ephemeral" } } as ContentBlockParam;
  return [...cleaned.slice(0, -1), { ...last, content }];
}

/**
 * Content from an API response that is safe to echo back in history.
 *
 * With server-side fallbacks, a mid-output decline leaves a `fallback`
 * block marking the switch point. Per the fallback rules, blocks before the
 * final boundary are dropped except text (thinking / tool_use from the
 * declining model must not be echoed), and the `fallback` markers are
 * dropped (they are audit-only).
 */
export function toEchoableContent(content: readonly { type: string }[]): ContentBlockParam[] {
  let lastFallback = -1;
  content.forEach((b, i) => {
    if (b.type === "fallback") lastFallback = i;
  });
  const out: ContentBlockParam[] = [];
  content.forEach((b, i) => {
    if (b.type === "fallback") return;
    if (i < lastFallback && b.type !== "text") return;
    out.push(b as unknown as ContentBlockParam);
  });
  return out;
}

// ─────────────────────────────────────────────────────────────
//  Errors
// ─────────────────────────────────────────────────────────────

function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (err instanceof Anthropic.APIUserAbortError) return true;
  return err instanceof Error && err.name === "AbortError";
}

function isRetryable(err: unknown): boolean {
  if (err instanceof Anthropic.APIUserAbortError) return false;
  if (err instanceof Anthropic.APIConnectionError) return true;
  if (err instanceof Anthropic.APIError) {
    if (err.status !== undefined) return RETRYABLE_STATUS.has(err.status);
    // Mid-stream SSE `error` events carry no HTTP status, only a type.
    return err.type !== null && RETRYABLE_STREAM_ERROR_TYPES.has(err.type);
  }
  return false;
}

function userSafeError(err: unknown): string {
  if (err instanceof Anthropic.RateLimitError) {
    return "Neo is handling too many requests right now. Please wait a moment and try again.";
  }
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return "Neo could not authenticate with the AI service. Please contact the site administrator.";
  }
  if (err instanceof Anthropic.BadRequestError) {
    return "The request could not be processed. If this conversation is very long, try starting a new one.";
  }
  if (err instanceof Anthropic.APIError && (err.status === 529 || err.type === "overloaded_error")) {
    return "Claude is temporarily overloaded. Please try again in a moment.";
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return "Neo could not reach the AI service. Please try again in a moment.";
  }
  return "Something went wrong while generating a response. Please try again.";
}

function describeError(err: unknown): Record<string, unknown> {
  if (err instanceof Anthropic.APIError) {
    return {
      statusCode: err.status,
      errorType: err.type ?? err.constructor.name,
      errorMessage: err.message.slice(0, 300),
    };
  }
  return { errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Anthropic.APIUserAbortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Anthropic.APIUserAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ─────────────────────────────────────────────────────────────
//  Run state
// ─────────────────────────────────────────────────────────────

interface RunState {
  opts: RunAgentOptions;
  client: Anthropic;
  model: string;
  history: MessageParam[];
  initialLength: number;
  usage: AgentUsage;
  emit: (e: AgentEvent) => Promise<void>;
}

class LoopExit {
  constructor(
    readonly stopReason: string,
    readonly error?: string,
    readonly pending?: PendingConfirmation,
  ) {}
}

function makeEmitter(opts: RunAgentOptions): (e: AgentEvent) => Promise<void> {
  return async (e) => {
    try {
      await opts.onEvent(e);
    } catch (err) {
      // A broken client stream must not abort the run (state still gets persisted).
      logger.warn("onEvent callback threw", COMPONENT, {
        conversationId: opts.ctx.conversationId,
        ...describeError(err),
      });
    }
  };
}

function newState(opts: RunAgentOptions): RunState {
  return {
    opts,
    client: getClient(opts),
    model: opts.model ?? agentModel(),
    history: [...opts.messages],
    initialLength: opts.messages.length,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    emit: makeEmitter(opts),
  };
}

function result(state: RunState, exit: LoopExit): AgentResult {
  return {
    messages: state.history,
    newMessages: state.history.slice(state.initialLength),
    usage: state.usage,
    stopReason: exit.stopReason,
    ...(exit.pending ? { pendingConfirmation: exit.pending } : {}),
    ...(exit.error ? { error: exit.error } : {}),
  };
}

// ─────────────────────────────────────────────────────────────
//  One model call (streamed, with retry)
// ─────────────────────────────────────────────────────────────

interface ModelTurn {
  message: Message;
  content: ContentBlockParam[];
  servedByFallback: boolean;
}

async function callModel(state: RunState, iteration: number): Promise<ModelTurn> {
  const { opts, client } = state;
  const signal = opts.ctx.signal;
  const definitions = opts.tools.list();
  const tools = buildTools(definitions);
  const systemTokens = Math.ceil((opts.system.length + JSON.stringify(tools).length) / CHARS_PER_TOKEN);

  const prepared = await prepareMessages(state.history, {
    client,
    systemTokens,
    conversationId: opts.ctx.conversationId,
    userId: opts.ctx.userId,
  });
  const messages = stampCacheBreakpoint(mergeConsecutiveUserMessages(prepared));

  const system: TextBlockParam[] = [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }];
  const base: MessageCreateParamsBase = {
    model: state.model,
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    system,
    messages,
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: opts.effort ?? DEFAULT_EFFORT },
    metadata: { user_id: hashPii(opts.ctx.userId) },
    ...(tools.length > 0 ? { tools } : {}),
  };
  const useFallbacks = opts.enableFallbacks ?? fallbacksEnabled();
  const maxRetries = opts.retry?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelay = opts.retry?.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;

  for (let attempt = 0; ; attempt++) {
    let emitted = false;
    try {
      const stream = useFallbacks
        ? client.beta.messages.stream(
            {
              ...base,
              betas: [SERVER_SIDE_FALLBACK_BETA],
              fallbacks: "default",
            } as unknown as BetaMessageStreamParams,
            { signal },
          )
        : client.messages.stream(base, { signal });

      for await (const raw of stream as AsyncIterable<unknown>) {
        const event = raw as RawMessageStreamEvent;
        if (event.type !== "content_block_delta") continue;
        if (event.delta.type === "text_delta" && event.delta.text) {
          emitted = true;
          await state.emit({ type: "text_delta", text: event.delta.text });
        } else if (event.delta.type === "thinking_delta" && event.delta.thinking) {
          emitted = true;
          await state.emit({ type: "thinking", text: event.delta.thinking });
        }
      }
      // The SDK iterator returns silently when aborted; don't mistake that for success.
      if (signal?.aborted) throw new Anthropic.APIUserAbortError();
      const message = (await stream.finalMessage()) as unknown as Message;

      const iterations = (message.usage as { iterations?: Array<{ type?: string }> | null }).iterations ?? [];
      const servedByFallback = iterations.some((it) => it.type === "fallback_message");
      if (servedByFallback) {
        logger.info("Response served by refusal fallback model", COMPONENT, {
          conversationId: opts.ctx.conversationId,
          model: state.model,
          servedByModel: message.model,
          stopReason: message.stop_reason,
        });
      }
      return {
        message,
        content: toEchoableContent(message.content as readonly { type: string }[]),
        servedByFallback,
      };
    } catch (err) {
      if (isAbortError(err, signal)) throw err;
      if (!isRetryable(err) || emitted || attempt >= maxRetries) throw err;
      const delayMs = Math.min(baseDelay * 2 ** attempt, MAX_RETRY_DELAY_MS);
      logger.warn("Model call failed, retrying", COMPONENT, {
        conversationId: opts.ctx.conversationId,
        iteration,
        attempt: attempt + 1,
        maxRetries,
        delayMs,
        ...describeError(err),
      });
      await sleep(delayMs, signal);
    }
  }
}

function recordUsage(state: RunState, message: Message): AgentEvent {
  const u = message.usage;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheCreation = u.cache_creation_input_tokens ?? 0;
  state.usage.input_tokens += u.input_tokens;
  state.usage.output_tokens += u.output_tokens;
  state.usage.cache_read_input_tokens = (state.usage.cache_read_input_tokens ?? 0) + cacheRead;
  state.usage.cache_creation_input_tokens = (state.usage.cache_creation_input_tokens ?? 0) + cacheCreation;
  const totalIn = u.input_tokens + cacheRead + cacheCreation;
  logger.info("API usage", COMPONENT, {
    conversationId: state.opts.ctx.conversationId,
    tenantId: state.opts.ctx.tenantId,
    model: message.model,
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
    cacheHitRate: totalIn > 0 ? cacheRead / totalIn : 0,
    stopReason: message.stop_reason,
  });
  return {
    type: "usage",
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation,
  };
}

// ─────────────────────────────────────────────────────────────
//  Tool execution
// ─────────────────────────────────────────────────────────────

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 2000) || "Tool failed";
}

async function executeTool(
  state: RunState,
  tool: RegisteredTool,
  block: { id: string; name: string; input: unknown },
): Promise<ToolResultBlockParam> {
  const { ctx } = state.opts;
  const started = Date.now();
  try {
    const output = await tool.execute(block.input, ctx);
    const durationMs = Date.now() - started;
    logger.info("Tool completed", COMPONENT, {
      conversationId: ctx.conversationId,
      toolName: block.name,
      toolUseId: block.id,
      isDestructive: tool.definition.destructive === true,
      durationMs,
      isError: false,
    });
    await state.emit({ type: "tool_result", id: block.id, name: block.name, result: output });
    return {
      type: "tool_result",
      tool_use_id: block.id,
      content: wrapToolResult(block.name, output, { conversationId: ctx.conversationId }),
    };
  } catch (err) {
    const durationMs = Date.now() - started;
    const output = { error: errorText(err) };
    logger.warn("Tool failed", COMPONENT, {
      conversationId: ctx.conversationId,
      toolName: block.name,
      toolUseId: block.id,
      isDestructive: tool.definition.destructive === true,
      durationMs,
      isError: true,
      ...describeError(err),
    });
    await state.emit({ type: "tool_result", id: block.id, name: block.name, result: output, is_error: true });
    return errorResult(block.name, block.id, output, state);
  }
}

function errorResult(
  toolName: string,
  toolUseId: string,
  output: { error: string },
  state: RunState,
): ToolResultBlockParam {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: wrapToolResult(toolName, output, { conversationId: state.opts.ctx.conversationId }),
    is_error: true,
  };
}

/**
 * Run every tool_use in one assistant message. Non-destructive tools run in
 * parallel. The first destructive tool becomes the pending confirmation;
 * any further destructive tool in the same message gets an is_error result
 * (one confirmation at a time). Results keep tool_use order.
 */
async function runToolUses(
  state: RunState,
  toolUses: ToolUseBlockParam[],
): Promise<{ results: ToolResultBlockParam[]; pending?: { block: ToolUseBlockParam; tool: RegisteredTool } }> {
  let pending: { block: ToolUseBlockParam; tool: RegisteredTool } | undefined;
  const slots: Array<Promise<ToolResultBlockParam> | undefined> = [];

  for (const block of toolUses) {
    const tool = state.opts.tools.get(block.name);
    if (!tool) {
      logger.warn("Model called an unregistered tool", COMPONENT, {
        conversationId: state.opts.ctx.conversationId,
        toolName: block.name.slice(0, 64),
        toolUseId: block.id,
      });
      const output = { error: `Unknown tool "${block.name}". Use only the tools provided.` };
      await state.emit({ type: "tool_result", id: block.id, name: block.name, result: output, is_error: true });
      slots.push(Promise.resolve(errorResult(block.name, block.id, output, state)));
      continue;
    }
    if (tool.definition.destructive) {
      if (!pending) {
        pending = { block, tool };
        slots.push(undefined);
      } else {
        logger.warn("Second destructive tool in one turn rejected", COMPONENT, {
          conversationId: state.opts.ctx.conversationId,
          toolName: block.name,
          toolUseId: block.id,
        });
        const output = {
          error:
            "Only one action that needs user confirmation can be proposed at a time. " +
            "Wait for the user to respond to the pending action, then propose this one again if still needed.",
        };
        await state.emit({ type: "tool_result", id: block.id, name: block.name, result: output, is_error: true });
        slots.push(Promise.resolve(errorResult(block.name, block.id, output, state)));
      }
      continue;
    }
    await state.emit({ type: "tool_start", id: block.id, name: block.name, input: block.input });
    slots.push(executeTool(state, tool, block));
  }

  const settled = await Promise.all(slots);
  const results = settled.filter((r): r is ToolResultBlockParam => r !== undefined);
  return pending ? { results, pending } : { results };
}

// ─────────────────────────────────────────────────────────────
//  The loop
// ─────────────────────────────────────────────────────────────

function lastIsUnpairedToolUse(state: RunState): boolean {
  const last = state.history[state.history.length - 1];
  return (
    state.history.length > state.initialLength &&
    last?.role === "assistant" &&
    typeof last.content !== "string" &&
    last.content.some((b) => b.type === "tool_use")
  );
}

function markInterrupted(state: RunState): void {
  if (lastIsUnpairedToolUse(state)) {
    const last = state.history[state.history.length - 1]!;
    const kept = (last.content as ContentBlockParam[]).filter((b) => b.type === "text");
    state.history[state.history.length - 1] = {
      role: "assistant",
      content: [...kept, { type: "text", text: "[interrupted]" }],
    };
    return;
  }
  state.history.push({ role: "assistant", content: [{ type: "text", text: "[interrupted]" }] });
}

async function loop(state: RunState): Promise<LoopExit> {
  const { opts } = state;
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (opts.ctx.signal?.aborted) throw new Anthropic.APIUserAbortError();

    const { message, content } = await callModel(state, iteration);
    await state.emit(recordUsage(state, message));
    const stop = message.stop_reason ?? "unknown";

    // Refusal: check before reading content. Partial output is discarded.
    if (stop === "refusal") {
      logger.warn("Model refused the request", COMPONENT, {
        conversationId: opts.ctx.conversationId,
        model: message.model,
        refusalCategory: message.stop_details?.category ?? null,
      });
      await state.emit({ type: "error", message: REFUSAL_MESSAGE });
      return new LoopExit("refusal", REFUSAL_MESSAGE);
    }

    const toolUses = content.filter((b): b is ToolUseBlockParam => b.type === "tool_use");

    if (stop === "max_tokens") {
      if (toolUses.length > 0) {
        // A truncated tool input can still parse; never run it.
        const kept = content.filter((b) => b.type !== "tool_use");
        state.history.push({ role: "assistant", content: [...kept, { type: "text", text: "[truncated]" }] });
        await state.emit({ type: "error", message: MAX_TOKENS_TOOL_MESSAGE });
        return new LoopExit("max_tokens", MAX_TOKENS_TOOL_MESSAGE);
      }
      state.history.push({ role: "assistant", content: [...content, { type: "text", text: "[truncated]" }] });
      return new LoopExit("max_tokens");
    }

    if (stop === "pause_turn") {
      if (content.length > 0) state.history.push({ role: "assistant", content });
      continue;
    }

    if (stop === "tool_use" && toolUses.length > 0) {
      state.history.push({ role: "assistant", content });
      if (opts.ctx.signal?.aborted) throw new Anthropic.APIUserAbortError();

      const { results, pending } = await runToolUses(state, toolUses);
      if (results.length > 0) state.history.push({ role: "user", content: results });

      if (pending) {
        const { block, tool } = pending;
        logger.info("Confirmation gate triggered", COMPONENT, {
          conversationId: opts.ctx.conversationId,
          toolName: block.name,
          toolUseId: block.id,
        });
        await state.emit({
          type: "confirmation_required",
          id: block.id,
          name: block.name,
          input: block.input,
          description: tool.definition.description,
        });
        return new LoopExit("confirmation_required", undefined, {
          id: block.id,
          name: block.name,
          input: block.input,
        });
      }
      if (opts.ctx.signal?.aborted) throw new Anthropic.APIUserAbortError();
      continue;
    }

    if (stop === "model_context_window_exceeded") {
      if (content.length > 0) state.history.push({ role: "assistant", content });
      await state.emit({ type: "error", message: CONTEXT_EXCEEDED_MESSAGE });
      return new LoopExit(stop, CONTEXT_EXCEEDED_MESSAGE);
    }

    // end_turn, stop_sequence, or anything else terminal.
    if (content.length > 0) state.history.push({ role: "assistant", content });
    return new LoopExit(stop);
  }

  logger.warn("Agent loop hit max iterations", COMPONENT, {
    conversationId: opts.ctx.conversationId,
    iteration: maxIterations,
  });
  await state.emit({ type: "error", message: MAX_ITERATIONS_MESSAGE });
  return new LoopExit("max_iterations", MAX_ITERATIONS_MESSAGE);
}

async function runWithState(state: RunState): Promise<AgentResult> {
  const { opts } = state;
  let exit: LoopExit;
  try {
    exit = await loop(state);
  } catch (err) {
    if (isAbortError(err, opts.ctx.signal)) {
      markInterrupted(state);
      logger.info("Agent loop interrupted", COMPONENT, { conversationId: opts.ctx.conversationId });
      exit = new LoopExit("interrupted");
    } else {
      const message = userSafeError(err);
      logger.error("Agent loop failed", COMPONENT, {
        conversationId: opts.ctx.conversationId,
        tenantId: opts.ctx.tenantId,
        model: state.model,
        ...describeError(err),
      });
      // Never leave an assistant tool_use without its results.
      if (lastIsUnpairedToolUse(state)) state.history.pop();
      await state.emit({ type: "error", message });
      exit = new LoopExit("error", message);
    }
  }
  await state.emit({ type: "done", stop_reason: exit.stopReason });
  return result(state, exit);
}

/**
 * Run the agent until Claude ends its turn, a destructive tool needs
 * confirmation, a refusal / error occurs, or the signal aborts. Never
 * throws for API or tool failures: they surface as an `error` event plus
 * `stopReason`, and the returned `messages` are always a valid history to
 * persist. A `done` event is always the last event.
 */
export async function runAgentLoop(opts: RunAgentOptions): Promise<AgentResult> {
  const state = newState(opts);
  logger.info("Agent loop started", COMPONENT, {
    conversationId: opts.ctx.conversationId,
    tenantId: opts.ctx.tenantId,
    userIdHash: hashPii(opts.ctx.userId),
    model: state.model,
    effort: opts.effort ?? DEFAULT_EFFORT,
    toolCount: opts.tools.list().length,
  });
  return runWithState(state);
}

/**
 * Locate the pending tool_use in history and check it is still awaiting a result.
 * Returns the authoritative block (its input is what the user was shown).
 */
function findPendingToolUse(
  messages: readonly MessageParam[],
  pending: PendingConfirmation,
): ToolUseBlockParam | undefined {
  let a = messages.length - 1;
  while (a >= 0 && messages[a]!.role === "user") a--;
  const assistant = messages[a];
  if (!assistant || typeof assistant.content === "string") return undefined;
  const block = assistant.content.find(
    (b): b is ToolUseBlockParam => b.type === "tool_use" && b.id === pending.id && b.name === pending.name,
  );
  if (!block) return undefined;
  for (let j = a + 1; j < messages.length; j++) {
    const c = messages[j]!.content;
    if (typeof c !== "string" && c.some((b) => b.type === "tool_result" && b.tool_use_id === pending.id)) {
      return undefined;
    }
  }
  return block;
}

/**
 * Resume after the user approved or declined a pending destructive tool.
 * `opts.messages` must be the history returned with `pendingConfirmation`.
 * Approved: the tool runs and its (wrapped) result is appended; declined: a
 * wrapped "user declined" result is appended. Then the loop continues.
 */
export async function resumeAfterConfirmation(
  opts: RunAgentOptions & { approved: boolean; pending: PendingConfirmation },
): Promise<AgentResult> {
  const { approved, pending, ...runOpts } = opts;
  const state = newState(runOpts);
  const { ctx } = runOpts;

  const block = findPendingToolUse(state.history, pending);
  const tool = block ? runOpts.tools.get(block.name) : undefined;
  if (!block || !tool || !tool.definition.destructive) {
    logger.warn("Stale or invalid confirmation", COMPONENT, {
      conversationId: ctx.conversationId,
      toolName: pending.name.slice(0, 64),
      toolUseId: pending.id.slice(0, 64),
    });
    await state.emit({ type: "error", message: STALE_CONFIRMATION_MESSAGE });
    await state.emit({ type: "done", stop_reason: "error" });
    return result(state, new LoopExit("error", STALE_CONFIRMATION_MESSAGE));
  }

  logger.info("Confirmation resolved", COMPONENT, {
    conversationId: ctx.conversationId,
    toolName: block.name,
    toolUseId: block.id,
    approved,
  });

  let toolResult: ToolResultBlockParam;
  if (approved) {
    await state.emit({ type: "tool_start", id: block.id, name: block.name, input: block.input });
    toolResult = await executeTool(state, tool, block);
  } else {
    const output = {
      cancelled: true,
      message: "The user declined this action. Do not retry it unless the user asks again.",
    };
    await state.emit({ type: "tool_result", id: block.id, name: block.name, result: output, is_error: true });
    toolResult = {
      type: "tool_result",
      tool_use_id: block.id,
      content: wrapToolResult(block.name, output, { conversationId: ctx.conversationId }),
    };
  }
  // A separate user message: consecutive user messages form one turn, so this
  // pairs with the tool_use alongside any results recorded before the pause.
  state.history.push({ role: "user", content: [toolResult] });
  return runWithState(state);
}
