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
  type ToolContext,
  type ToolRegistry,
} from "@neo/core";
import { createCheckUrlTool, createInMemoryCache } from "@neo/tools";
// ── Phase 1: intake tools. TODO(integration): import these two from "@neo/tools" instead. ──
import { createAnalyzeEmailTool, createAnalyzeSmsTool } from "./phase1-stubs";
import { parseAttachmentNote } from "@/lib/attachments";
import { env } from "@/lib/env";
import type { NeoSession } from "@/lib/session";
import { getArtifactStore } from "./artifacts";
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
  // ── Phase 1: intake tools (analyze_email, analyze_sms) ──
  tools.push(
    createAnalyzeEmailTool({ deps: { cache: g.__neoUrlCache }, loadArtifact: loadArtifactForTool }),
    createAnalyzeSmsTool({ deps: { cache: g.__neoUrlCache } }),
  );
  // ── end Phase 1: intake tools ──
  if (opts.mock) tools.push(mockReportPhishTool);
  return createToolRegistry(tools);
}

// ── Phase 1: intake tools ──
const ARTIFACT_REF_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * analyze_email's `loadArtifact`: the tenant comes from the ToolContext the
 * agent loop passes (the session tenant), never from the model's input.
 */
export async function loadArtifactForTool(ref: string, ctx: ToolContext): Promise<Uint8Array | undefined> {
  if (!ARTIFACT_REF_RE.test(ref)) return undefined;
  const store = getArtifactStore();
  if (!store) return undefined;
  const meta = await store.get(ref.toLowerCase(), ctx.tenantId);
  // Screenshots are for the model's eyes, not the email parser.
  if (!meta || meta.kind === "image") return undefined;
  return store.read(meta.id, ctx.tenantId);
}

/** Id of the first attachment note in the given messages (the turn's user message), if any. */
export function firstAttachmentId(messages: readonly MessageParam[]): string | undefined {
  for (const m of messages) {
    if (m.role !== "user" || typeof m.content === "string") continue;
    for (const b of m.content) {
      const ref = b.type === "text" ? parseAttachmentNote(b.text) : null;
      if (ref) return ref.id;
    }
  }
  return undefined;
}
// ── end Phase 1: intake tools ──

/** The scripted client in MOCK_MODE; otherwise undefined (@neo/core builds the real one from env). */
export function agentClient(): Anthropic | undefined {
  const e = env();
  return e.MOCK_MODE ? createMockAnthropicClient({ delayMs: e.MOCK_STREAM_DELAY_MS }) : undefined;
}

export function agentEffort(): Effort {
  const raw = process.env.NEO_AGENT_EFFORT?.trim().toLowerCase();
  return raw === "low" || raw === "high" ? raw : "medium";
}

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
    effort: agentEffort(),
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
      // ── Phase 1: intake — link the verdict to the turn's first attachment ──
      const artifactId = firstAttachmentId(prefix);
      if (artifactId && !verdict.raw_ref) verdict.raw_ref = artifactId;
      await saveVerdict({ tenantId: session.tenantId, userId: session.userId, conversationId, verdict, ...(artifactId ? { artifactId } : {}) });
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
