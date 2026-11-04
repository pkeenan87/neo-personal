import { catalogEntryFor, hashPii, logger } from "@neo/core";
import type { Verdict } from "@neo/verdict";
import { calls, reply, runs, type SessionView } from "eve/events";
import { emailAnalysesFromOutputs, selectSigninAnalysis } from "@/lib/server/signin/chat-hook";
import { applyAmbiguousSigninCap, applySigninHookFailureCap } from "@/lib/server/signin/override";
import { finalizeSigninVerdict, persistSigninEvent, type FinalizedSigninVerdict } from "@/lib/server/signin/service";
import { recordUsage } from "@/lib/server/usage";
import { extractVerdict, saveChatVerdict } from "@/lib/server/verdicts";
import { tenantCallerOf, type EveCaller } from "./tenant";
import { isRefusalModel } from "./usage-gate";

/** What a settled turn left on the stream that Neo acts on. Plain data, so the logic below runs without a session. */
export interface TurnFacts {
  /** One entry per model call of the turn. */
  runs: { modelId?: string; usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } }[];
  /** The turn's reply text (text parts joined); null when a part was too large to read inline. */
  replyText: string | null;
  /** `analyze_email` results of the turn (inline outputs only). */
  emailOutputs: unknown[];
  /** `analyze_email` calls whose result could not be read (stored by reference). */
  unreadableEmailCalls: number;
}

/** Read a turn's facts from the session view eve hands a channel handler. */
export function turnFactsFromView(view: SessionView, turnId: string): TurnFacts {
  let replyText: string | null = "";
  for (const p of reply(view, turnId)) {
    if (p.kind !== "text") continue;
    const text = typeof p.value === "string" ? p.value : p.fallbackText;
    replyText = replyText === null || text === undefined ? null : replyText + text;
  }
  const emailCalls = calls(view, { turnId, name: "analyze_email" });
  return {
    runs: runs(view, { turnId }).map((r) => ({
      ...(r.modelId ? { modelId: r.modelId } : {}),
      ...(r.usage ? { usage: r.usage } : {}),
    })),
    replyText,
    emailOutputs: emailCalls.flatMap((c) => (c.output !== undefined ? [c.output] : [])),
    unreadableEmailCalls: emailCalls.filter((c) => c.state === "completed" && c.output === undefined).length,
  };
}

export interface TurnSettleDeps {
  recordUsage: typeof recordUsage;
  saveChatVerdict: typeof saveChatVerdict;
  persistSigninEvent: typeof persistSigninEvent;
  finalizeSigninVerdict: typeof finalizeSigninVerdict;
}

const defaultDeps: TurnSettleDeps = { recordUsage, saveChatVerdict, persistSigninEvent, finalizeSigninVerdict };

/**
 * Record the turn's usage as the old chat does (`streamAgentRun`: one `usage_events` row per turn, tokens
 * summed across the turn's model calls, `kind: "check"`, tier from the catalog), then store the verdict the
 * reply carries (`source: "chat"`, through the same sign-in hook). Neither can fail the turn: both log.
 *
 * - The caller is the verified one; a turn without a household caller records nothing.
 * - A turn that never reached a model records nothing, and neither does the canned cap refusal (the old chat
 *   records nothing for a request refused before the loop).
 * - eve's per-run model id is the requested model; a gateway fallback is not visible here.
 */
export async function settleTurn(caller: EveCaller | null | undefined, facts: TurnFacts, deps: TurnSettleDeps = defaultDeps): Promise<void> {
  const who = tenantCallerOf(caller);
  if (!who) return;
  if (facts.runs.length === 0 || facts.runs.some((r) => isRefusalModel(r.modelId))) return;

  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const r of facts.runs) {
    total.input += r.usage?.inputTokens ?? 0;
    total.output += r.usage?.outputTokens ?? 0;
    total.cacheRead += r.usage?.cacheReadTokens ?? 0;
    total.cacheWrite += r.usage?.cacheWriteTokens ?? 0;
  }
  const model = [...facts.runs].reverse().find((r) => r.modelId)?.modelId ?? "unknown";
  const tier = catalogEntryFor(model)?.tier;
  await deps.recordUsage({
    tenantId: who.tenantId,
    userId: who.userId,
    model,
    inputTokens: total.input,
    outputTokens: total.output,
    cacheReadTokens: total.cacheRead,
    cacheCreationTokens: total.cacheWrite,
    kind: "check",
    ...(tier ? { tier } : {}),
  });

  try {
    await storeVerdict(who, facts, deps);
  } catch (err) {
    logger.error("Eve chat verdict handling failed", "eve.chat", {
      tenantId: who.tenantId,
      userIdHash: hashPii(who.userId),
      errorMessage: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
    });
  }
}

async function storeVerdict(who: { tenantId: string; userId: string }, facts: TurnFacts, deps: TurnSettleDeps): Promise<void> {
  if (facts.replyText === null) {
    logger.warn("Eve chat reply too large to read; verdict not stored", "eve.chat", { tenantId: who.tenantId });
    return;
  }
  // extractVerdict drops any model-written `signin_check`: only finalizeSigninVerdict may set one.
  const modelVerdict = extractVerdict([{ role: "assistant", content: facts.replyText }]);
  if (!modelVerdict) return;

  const analyses = emailAnalysesFromOutputs(facts.emailOutputs);
  // A result stored by reference cannot be read here, so the sign-in rules cannot run on it (the old chat has a
  // second copy of the analysis for that case). A model-claimed `signin_alert` with no analysis is still capped below.
  if (facts.unreadableEmailCalls > 0) logger.warn("analyze_email result unreadable; sign-in rules skipped", "eve.chat", { tenantId: who.tenantId });
  let verdict: Verdict = modelVerdict;
  let event: FinalizedSigninVerdict["event"] = null;
  try {
    const choice = selectSigninAnalysis(analyses, modelVerdict);
    if (choice.kind === "none" && modelVerdict.subject_type === "signin_alert") verdict = applyAmbiguousSigninCap(modelVerdict);
    if (choice.kind === "analysis") {
      const finalized = await deps.finalizeSigninVerdict({ ...who, analysis: choice.analysis, verdict: modelVerdict, source: "forwarded" });
      verdict = finalized.verdict;
      event = finalized.event;
    } else if (choice.kind === "ambiguous") {
      verdict = applyAmbiguousSigninCap(modelVerdict);
    }
  } catch (err) {
    logger.error("Sign-in alert hook failed", "eve.chat", {
      tenantId: who.tenantId,
      errorMessage: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
    });
    // Fail closed: the rules did not run, so a turn that touched a sign-in alert never keeps a `likely_safe`.
    event = null;
    verdict = applySigninHookFailureCap(modelVerdict);
  }

  const verdictId = await deps.saveChatVerdict({ ...who, verdict });
  await deps.persistSigninEvent({ ...who, verdictId, event });
  logger.info("Verdict stored", "eve.chat", {
    tenantId: who.tenantId,
    ...(verdictId ? { verdictId } : {}),
    source: "chat",
    verdict: verdict.verdict,
    subjectType: verdict.subject_type,
    confidence: verdict.confidence,
  });
}
