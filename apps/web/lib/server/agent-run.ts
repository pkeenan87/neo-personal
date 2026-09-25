/**
 * Shared plumbing for /api/agent and /api/agent/confirm: the tool registry,
 * the model client (scripted in MOCK_MODE), and the streamed run that always
 * persists the turn, records usage, and stores any verdict, even on error or
 * client disconnect.
 */
import type Anthropic from "@anthropic-ai/sdk";
import {
  agentModel,
  createEventStream,
  createToolRegistry,
  hashPii,
  logger,
  type AgentEvent,
  type AgentResult,
  type Effort,
  type MessageParam,
  type RegisteredTool,
  type RunAgentOptions,
  type ToolRegistry,
} from "@neo/core";
import { createCheckUrlTool, createInMemoryCache } from "@neo/tools";
import { env } from "@/lib/env";
import { playbookMarker, type PlaybookId } from "@/lib/playbooks";
import type { NeoSession } from "@/lib/session";
import { getConversationStore } from "./conversation-store";
import { NDJSON_HEADERS } from "./http";
import { createMockAnthropicClient, mockReportPhishTool } from "./mock-model";
import { NEO_SYSTEM_PROMPT } from "./system-prompt";
import { recordUsage } from "./usage";
import { extractVerdict, saveVerdict } from "./verdicts";

const g = globalThis as typeof globalThis & { __neoUrlCache?: ReturnType<typeof createInMemoryCache> };

/** check_url with a process-wide reputation cache; MOCK_MODE adds a destructive demo tool. */
export function buildToolRegistry(opts: { mock: boolean } = { mock: env().MOCK_MODE }): ToolRegistry {
  g.__neoUrlCache ??= createInMemoryCache();
  const tools: RegisteredTool[] = [createCheckUrlTool({ deps: { cache: g.__neoUrlCache } })];
  if (opts.mock) tools.push(mockReportPhishTool);
  return createToolRegistry(tools);
}

/** The scripted client in MOCK_MODE; otherwise undefined (@neo/core builds the real one from env). */
export function agentClient(): Anthropic | undefined {
  const e = env();
  return e.MOCK_MODE ? createMockAnthropicClient({ delayMs: e.MOCK_STREAM_DELAY_MS }) : undefined;
}

/**
 * Per-turn effort. `high` when this turn starts a playbook (`playbook` in the
 * request) or the previous assistant turn declared one with the
 * `<!-- playbook:<id> -->` marker; otherwise NEO_AGENT_EFFORT (default medium).
 */
export function agentEffort(turn: { playbook?: PlaybookId; history?: readonly MessageParam[] } = {}): Effort {
  // --- incident playbooks (agent E) ---
  if (turn.playbook || (turn.history && previousTurnPlaybook(turn.history))) return "high";
  // --- end incident playbooks ---
  const raw = process.env.NEO_AGENT_EFFORT?.trim().toLowerCase();
  return raw === "low" || raw === "high" ? raw : "medium";
}

// --- incident playbooks (agent E) ---
function isToolResultCarrier(m: MessageParam): boolean {
  return Array.isArray(m.content) && m.content.length > 0 && m.content.every((b) => b.type === "tool_result");
}

/** The playbook declared by the previous assistant turn (any of its messages starting with the marker), if any. */
export function previousTurnPlaybook(history: readonly MessageParam[]): PlaybookId | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.role === "user") {
      if (isToolResultCarrier(m)) continue;
      return null; // reached the user message that started the previous turn
    }
    const blocks = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
    for (const b of blocks) {
      if (b.type === "text") {
        const id = playbookMarker(b.text);
        if (id) return id;
      }
    }
  }
  return null;
}
// --- end incident playbooks ---

/** Model name recorded in usage_events. */
export function usageModel(): string {
  return env().MOCK_MODE ? "mock" : agentModel();
}

export interface AgentRunInput {
  session: NeoSession;
  conversationId: string;
  /** Messages persisted before the run output (e.g. the new user message). */
  prefix: MessageParam[];
  kind: "check" | "resume";
  signal: AbortSignal;
  /** Start the loop; receives the options shared by runAgentLoop and resumeAfterConfirmation. */
  run: (common: Omit<RunAgentOptions, "messages">) => Promise<AgentResult>;
  headers?: Record<string, string>;
  /** Per-turn effort (agentEffort({ playbook, history })); default agentEffort(). */
  effort?: Effort;
}

/**
 * Stream a run as NDJSON. After the loop ends (any stop reason) the turn is
 * appended, usage is recorded and a verdict row is written, then the stream closes.
 */
export function streamAgentRun(input: AgentRunInput): Response {
  const { session, conversationId, prefix, kind, signal, run } = input;
  const { readable, send, close } = createEventStream();
  const store = getConversationStore();
  const client = agentClient();

  const common: Omit<RunAgentOptions, "messages"> = {
    system: NEO_SYSTEM_PROMPT,
    tools: buildToolRegistry(),
    ctx: { tenantId: session.tenantId, userId: session.userId, conversationId, signal },
    effort: input.effort ?? agentEffort(),
    onEvent: send,
    ...(client ? { client } : {}),
  };

  void (async () => {
    let result: AgentResult | undefined;
    try {
      result = await run(common);
    } catch (err) {
      // runAgentLoop never throws by contract; this is a last-resort guard.
      logger.error("Agent run threw", "api.agent", {
        conversationId,
        tenantId: session.tenantId,
        errorMessage: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
      });
      const events: AgentEvent[] = [
        { type: "error", message: "Something went wrong while generating a response. Please try again." },
        { type: "done", stop_reason: "error" },
      ];
      for (const e of events) await send(e);
    }

    const newMessages = result?.newMessages ?? [];
    const usage = result?.usage ?? { input_tokens: 0, output_tokens: 0 };
    try {
      await store.appendTurn(conversationId, session.tenantId, {
        messages: [...prefix, ...newMessages],
        usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
        pendingConfirmation: result?.pendingConfirmation ?? null,
      });
    } catch (err) {
      logger.error("Persisting the turn failed", "api.agent", {
        conversationId,
        tenantId: session.tenantId,
        userIdHash: hashPii(session.userId),
        errorMessage: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
      });
    }
    await recordUsage({
      tenantId: session.tenantId,
      userId: session.userId,
      conversationId,
      model: usageModel(),
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
      kind,
    });
    const verdict = extractVerdict(newMessages);
    if (verdict) {
      await saveVerdict({ tenantId: session.tenantId, userId: session.userId, conversationId, verdict });
      logger.info("Verdict stored", "api.agent", {
        conversationId,
        tenantId: session.tenantId,
        verdict: verdict.verdict,
        subjectType: verdict.subject_type,
        confidence: verdict.confidence,
      });
    }
    await close();
  })();

  return new Response(readable, { headers: { ...NDJSON_HEADERS, ...input.headers } });
}
