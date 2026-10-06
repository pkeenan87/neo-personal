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
  type Route,
  type RunAgentOptions,
  type ToolContext,
  type ToolRegistry,
} from "@neo/core";
import type { ArtifactMeta } from "@neo/db";
import { PostgresReputationCache } from "@neo/db";
import { createAnalyzeEmailTool, createAnalyzeSmsTool, createCheckUrlTool, createInMemoryCache, type EmailAnalysis, type ReputationCache } from "@neo/tools";
import { parseAttachmentNote } from "@/lib/attachments";
import { env } from "@/lib/env";
import { playbookMarker, type PlaybookId } from "@/lib/playbooks";
import type { NeoSession } from "@/lib/session";
import { getArtifactStore } from "./artifacts";
import { recordAudit } from "./audit";
import { getConversationStore } from "./conversation-store";
import { getDb } from "./db";
import { NDJSON_HEADERS } from "./http";
import { createMockAnthropicClient, mockReportPhishTool } from "./mock-model";
import { routeTurn } from "./router";
import { getMemberPreferences } from "./routing-settings";
import { NEO_SYSTEM_PROMPT } from "./system-prompt";
import { recordUsage } from "./usage";
import type { Verdict } from "@neo/verdict";
import { extractModelVerdict, extractVerdict, saveChatVerdict } from "./verdicts";
import { checkBreachesTool } from "./tools/check-breaches";
import { reviewMySigninsTool } from "./tools/review-my-signins";
import { findEmailAnalyses, rewriteFinalVerdict, selectSigninAnalysis, signinOverrideNote, stripCheck } from "./signin/chat-hook";
import { applyAmbiguousSigninCap, applySigninHookFailureCap } from "./signin/override";
import { finalizeSigninVerdict, persistSigninEvent } from "./signin/service";

const g = globalThis as typeof globalThis & { __neoUrlCache?: ReputationCache; __neoUrlCacheDbBacked?: boolean };

/**
 * The process-wide URL reputation cache shared by chat tools, the inbound job and signal
 * escalations (_specs/signals.md "Shared reputation cache"). `PostgresReputationCache`
 * (`reputation_cache`, 24h TTL, no tenant) when a database is configured, so households share
 * lookups; the in-memory twin otherwise (MOCK_MODE / tests). Switches twin↔database if the
 * database becomes available after the first call (tests toggling DATABASE_URL).
 */
export function sharedUrlCache(): ReputationCache {
  const db = getDb();
  const dbBacked = Boolean(db);
  if (!g.__neoUrlCache || g.__neoUrlCacheDbBacked !== dbBacked) {
    g.__neoUrlCache = db ? new PostgresReputationCache(db) : createInMemoryCache();
    g.__neoUrlCacheDbBacked = dbBacked;
  }
  return g.__neoUrlCache;
}

/** check_url, analyze_email and analyze_sms with a shared reputation cache; MOCK_MODE adds a destructive demo tool. */
export function buildToolRegistry(opts: { mock: boolean; onEmailAnalysis?: (analysis: EmailAnalysis) => void } = { mock: env().MOCK_MODE }): ToolRegistry {
  const cache = sharedUrlCache();
  const tools: RegisteredTool[] = [createCheckUrlTool({ deps: { cache } }), checkBreachesTool, reviewMySigninsTool];
  // ── Phase 1: intake tools (analyze_email, analyze_sms) ──
  const analyzeEmail = createAnalyzeEmailTool({ deps: { cache }, loadArtifact: loadArtifactForTool });
  tools.push(
    // The sign-in alert hook reads the analysis from the turn's messages; a truncated tool result falls back to this copy.
    opts.onEmailAnalysis
      ? {
          ...analyzeEmail,
          execute: async (input, ctx) => {
            const result = await analyzeEmail.execute(input, ctx);
            if (result && typeof result === "object" && "authentication" in result) opts.onEmailAnalysis!(result as EmailAnalysis);
            return result;
          },
        }
      : analyzeEmail,
    createAnalyzeSmsTool({ deps: { cache } }),
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

/**
 * Per-turn effort. `high` when this turn starts a playbook (`playbook` in the
 * request) or the previous assistant turn declared one with the
 * `<!-- playbook:<id> -->` marker; otherwise NEO_AGENT_EFFORT (default medium).
 */
export function agentEffort(turn: { playbook?: PlaybookId; history?: readonly MessageParam[] } = {}): Effort {
  // --- incident playbooks ---
  if (turn.playbook || (turn.history && previousTurnPlaybook(turn.history))) return "high";
  // --- end incident playbooks ---
  const raw = process.env.NEO_AGENT_EFFORT?.trim().toLowerCase();
  return raw === "low" || raw === "high" ? raw : "medium";
}

// --- incident playbooks ---
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

/** Model name recorded in usage_events when the run reported none. */
export function usageModel(): string {
  return env().MOCK_MODE ? "mock" : agentModel();
}

// ── Phase 2: model routing ──
export interface RouteForTurnInput {
  session: NeoSession;
  /** What the user typed this turn ("" for attachment-only turns). */
  text: string;
  attachments?: readonly ArtifactMeta[];
  history: readonly MessageParam[];
  playbook?: PlaybookId;
  signal?: AbortSignal;
}

function attachmentKind(metas: readonly ArtifactMeta[] | undefined): "email" | "image" | "text" | null {
  const first = metas?.[0];
  if (!first) return null;
  if (first.kind === "image") return "image";
  if (first.kind === "text") return "text";
  return "email";
}

/** Number of user turns already in the conversation (tool-result carriers excluded). */
export function countPriorTurns(history: readonly MessageParam[]): number {
  return history.filter((m) => m.role === "user" && !isToolResultCarrier(m)).length;
}

/**
 * Route a new chat turn: the member's preference and family, the playbook (this
 * turn's or the one the previous reply declared), the attachment kind, the
 * conversation depth and the last verdict feed the router (`lib/server/router.ts`).
 */
export async function routeForTurn(input: RouteForTurnInput): Promise<Route> {
  const prefs = await getMemberPreferences(input.session.tenantId, input.session.userId);
  const playbook = input.playbook ?? previousTurnPlaybook(input.history);
  return routeTurn({
    text: input.text,
    hasAttachment: (input.attachments?.length ?? 0) > 0,
    attachmentKind: attachmentKind(input.attachments),
    priorTurns: countPriorTurns(input.history),
    previousVerdict: extractVerdict(input.history)?.verdict ?? null,
    playbook,
    preference: prefs.routingPreference,
    family: prefs.modelFamily,
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

/** Route for a resumed turn whose stored route is missing: rules only, never a Jev call. */
export async function routeForResume(session: NeoSession, history: readonly MessageParam[]): Promise<Route> {
  const prefs = await getMemberPreferences(session.tenantId, session.userId);
  return routeTurn(
    {
      text: "",
      hasAttachment: false,
      attachmentKind: null,
      priorTurns: countPriorTurns(history),
      previousVerdict: null,
      playbook: previousTurnPlaybook(history),
      preference: prefs.routingPreference,
      family: prefs.modelFamily,
    },
    { env: { ...process.env, NEO_ROUTER: "rules" } },
  );
}

const budgetAuditDays = new Map<string, string>();

/** One `usage.budget_exhausted` audit event per tenant per UTC day (per instance). */
async function noteBudgetExhausted(session: NeoSession, conversationId: string, route: Route | undefined): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  if (budgetAuditDays.get(session.tenantId) === day) return;
  budgetAuditDays.set(session.tenantId, day);
  await recordAudit(session.tenantId, session.userId, "usage.budget_exhausted", {
    conversationId,
    ...(route ? { model: route.model, tier: route.tier } : {}),
  });
}
// ── end Phase 2: model routing ──

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
  /** Per-turn effort (agentEffort({ playbook, history })); default agentEffort(). Ignored when `route` is set. */
  effort?: Effort;
  /** Phase 2: the turn's route (model, effort, tier). Persisted on the turn and emitted as the first event. */
  route?: Route;
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

  // Every analysis the tool produced this run: the fallback when a stored tool result was truncated.
  const emailAnalyses: EmailAnalysis[] = [];
  const common: Omit<RunAgentOptions, "messages"> = {
    system: NEO_SYSTEM_PROMPT,
    tools: buildToolRegistry({ mock: env().MOCK_MODE, onEmailAnalysis: (a) => void emailAnalyses.push(a) }),
    ctx: { tenantId: session.tenantId, userId: session.userId, conversationId, signal },
    effort: input.route?.effort ?? input.effort ?? agentEffort(),
    onEvent: send,
    ...(client ? { client } : {}),
    ...(input.route ? { route: input.route } : {}),
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

    let newMessages = result?.newMessages ?? [];
    // ── Sign-in alerts: the deterministic hook runs after the model's verdict and before it is stored ──
    // extractVerdict drops any model-written `signin_check`: only finalizeSigninVerdict may set one.
    let verdict = extractVerdict(newMessages);
    let signinEvent: Awaited<ReturnType<typeof finalizeSigninVerdict>>["event"] = null;
    if (verdict) {
      // The user saw the model's verdict stream live: when a rule changed anything visible, rewrite the stored
      // text, tell the client to redraw the card, and say why. `signin_check` is stored data, never in the text.
      const publishFinal = async (finalVerdict: Verdict) => {
        const shown = stripCheck(finalVerdict);
        const modelShown = extractModelVerdict(newMessages);
        if (JSON.stringify(shown) !== JSON.stringify(modelShown && stripCheck(modelShown))) {
          const note = signinOverrideNote(finalVerdict);
          newMessages = rewriteFinalVerdict(newMessages, shown, note);
          await send({ type: "verdict_override", verdict: shown });
          await send({ type: "text_delta", text: `\n\n${note}` });
        } else if (modelShown?.signin_check) {
          newMessages = rewriteFinalVerdict(newMessages, shown);
        }
      };
      try {
        const fromMessages = findEmailAnalyses(newMessages);
        const choice = selectSigninAnalysis(emailAnalyses.length >= fromMessages.length ? emailAnalyses : fromMessages, verdict);
        let finalVerdict = verdict;
        // A model-claimed signin_alert subject with no alert analysis behind it is capped like an ambiguous one.
        if (choice.kind === "none" && verdict.subject_type === "signin_alert") finalVerdict = applyAmbiguousSigninCap(verdict);
        if (choice.kind === "analysis") {
          const finalized = await finalizeSigninVerdict({ tenantId: session.tenantId, userId: session.userId, analysis: choice.analysis, verdict, source: "forwarded" });
          signinEvent = finalized.event;
          finalVerdict = finalized.verdict;
        } else if (choice.kind === "ambiguous") {
          finalVerdict = applyAmbiguousSigninCap(verdict);
        }
        await publishFinal(finalVerdict);
        verdict = finalVerdict;
      } catch (err) {
        logger.error("Sign-in alert hook failed", "api.agent", {
          conversationId,
          tenantId: session.tenantId,
          errorMessage: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
        });
        // Fail closed: the rules did not run, so a turn that touched a sign-in alert never keeps a `likely_safe`.
        let touchedAlert = verdict.subject_type === "signin_alert";
        try {
          touchedAlert ||= [...emailAnalyses, ...findEmailAnalyses(newMessages)].some((a) => !!a.signin_alert);
        } catch {
          touchedAlert = true; // cannot tell: cap rather than trust the model
        }
        if (touchedAlert) {
          try {
            verdict = applySigninHookFailureCap(verdict); // stored even if telling the client fails below
            await publishFinal(verdict);
          } catch (err2) {
            logger.error("Sign-in alert fail-closed cap failed", "api.agent", {
              conversationId,
              tenantId: session.tenantId,
              errorMessage: err2 instanceof Error ? err2.message.slice(0, 300) : String(err2).slice(0, 300),
            });
          }
        }
      }
    }
    // ── end Sign-in alerts ──
    const usage = result?.usage ?? { input_tokens: 0, output_tokens: 0 };
    try {
      await store.appendTurn(conversationId, session.tenantId, {
        messages: [...prefix, ...newMessages],
        usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
        pendingConfirmation: result?.pendingConfirmation ?? null,
        ...(input.route ? { route: input.route } : {}),
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
      model: result?.servedModel ?? input.route?.model ?? usageModel(),
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
      kind,
      ...(input.route ? { tier: input.route.tier } : {}),
    });
    if (result?.errorCode === "budget_exhausted") await noteBudgetExhausted(session, conversationId, input.route);
    if (verdict) {
      // ── Phase 1: intake — link the verdict to the turn's first attachment ──
      const artifactId = firstAttachmentId(prefix);
      if (artifactId && !verdict.raw_ref) verdict.raw_ref = artifactId;
      const verdictId = await saveChatVerdict({ tenantId: session.tenantId, userId: session.userId, conversationId, verdict, ...(artifactId ? { artifactId } : {}) });
      await persistSigninEvent({ tenantId: session.tenantId, userId: session.userId, verdictId, event: signinEvent });
      logger.info("Verdict stored", "api.agent", {
        conversationId,
        tenantId: session.tenantId,
        ...(verdictId ? { verdictId } : {}),
        ...(artifactId ? { artifactId } : {}),
        source: "chat",
        verdict: verdict.verdict,
        subjectType: verdict.subject_type,
        confidence: verdict.confidence,
      });
    }
    await close();
  })();

  return new Response(readable, { headers: { ...NDJSON_HEADERS, ...input.headers } });
}
