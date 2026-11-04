import {
  gatewayModelId,
  gatewayProviderOptions,
  modelEntryFor,
  requestShape,
  anthropicModelFor,
  type Route,
} from "@neo/core";
import { mockModel } from "eve/evals";
import { turns } from "eve/events";
import type { DynamicModelContext, ModelSelection } from "eve/models";
import { routeTurn } from "@/lib/server/router";
import { getMemberPreferences } from "@/lib/server/routing-settings";
import { INCIDENT_CONTEXT_PREFIX } from "./incident-pointer";
import { tenantCallerOf } from "./tenant";
import { gateTurn, REFUSAL_MODEL_ID, type TurnGate } from "./usage-gate";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** Room for every model on the ladder; eve compacts well before this. */
const CONTEXT_WINDOW_TOKENS = 200_000;

/**
 * The model for a route, in the shape a dynamic eve agent returns (options per model, not sibling
 * fields). eve always reaches models through AI Gateway, so the id is the gateway slug and the
 * provider options are Neo's gateway policy (ZDR, region, provider order, catalog fallbacks).
 *
 * Request shape follows the catalog entry exactly as the old chat's `requestShape` does: adaptive
 * thinking and `effort` for Anthropic models that take them, `reasoning` for other families that
 * list efforts, and neither for Haiku 4.5. Never `budget_tokens`.
 */
export function selectionForRoute(route: Pick<Route, "model" | "effort">, source: NodeJS.ProcessEnv = process.env): ModelSelection {
  const slug = gatewayModelId(route.model);
  const entry = modelEntryFor(slug, source);
  const shape = requestShape(entry, route.effort);
  const anthropic: Record<string, unknown> = {};
  if (shape.thinking) anthropic.thinking = { type: "adaptive" };
  if (shape.output_config) anthropic.effort = shape.output_config.effort;
  const isAnthropic = slug.startsWith("anthropic/");
  return {
    model: slug,
    modelContextWindowTokens: CONTEXT_WINDOW_TOKENS,
    ...(!isAnthropic && shape.output_config ? { reasoning: shape.output_config.effort } : {}),
    modelOptions: {
      // The gateway options are typed for the AI SDK's JSON value; the policy object is plain JSON.
      providerOptions: { ...gatewayProviderOptions(entry, source), ...(isAnthropic && Object.keys(anthropic).length > 0 ? { anthropic } : {}) } as never,
    },
  };
}

/** The plain text of a turn's opening message. */
function turnText(ctx: Pick<DynamicModelContext, "turn">): string {
  return (ctx.turn?.input ?? [])
    .map((p) => (p.kind === "text" ? p.text : ""))
    .join("\n")
    .trim();
}

/** The scripted model for MOCK_MODE: no network, deterministic, enough to see every tool and the verdict card locally. */
export function scriptedModel() {
  const verdictBlock = (subject: "url" | "email" | "sms") =>
    "```verdict\n" +
    JSON.stringify({
      subject_type: subject,
      verdict: "insufficient_evidence",
      confidence: 0.5,
      headline: "This is a mock check, so Neo cannot say whether it is safe.",
      indicators: [{ severity: "low", category: "mock_mode", evidence: "MOCK_MODE is on", explanation: "No real checks ran." }],
      recommended_actions: [{ action: "Do not click or reply until a real check runs.", urgency: "now" }],
      iocs: { urls: [], domains: [], ips: [], hashes: [], phone_numbers: [] },
    }) +
    "\n```";
  return mockModel(({ messages, toolResults, lastUserMessage }) => {
    const last = toolResults.at(-1);
    if (!last) {
      // An incident chat starts with the server-checked pointer from agent/lib/incident-context.ts.
      const pointer = messages.map((m) => new RegExp(`${INCIDENT_CONTEXT_PREFIX}(${UUID})`, "i").exec(m.text)?.[1]).find(Boolean);
      if (pointer) return { toolCalls: [{ name: "get_incident", input: { incidentId: pointer } }] };
      const said = lastUserMessage ?? "";
      if (/sign-?in|signed in|was this you/i.test(said)) return { toolCalls: [{ name: "pending_signin_alerts", input: {} }] };
      if (/clicked|gift ?card|sent money|shared a code/i.test(said)) return { toolCalls: [{ name: "get_playbook", input: { id: "clicked_link" } }] };
      if (/^\s*(from|subject):/im.test(said)) return { toolCalls: [{ name: "analyze_email", input: { text: said } }] };
      if (/text message|\bsms\b/i.test(said) && !/https?:\/\//i.test(said)) return { toolCalls: [{ name: "analyze_sms", input: { body: said } }] };
      const url = /https?:\/\/\S+/.exec(said)?.[0] ?? "https://example.com/";
      return { toolCalls: [{ name: "analyze_url", input: { url } }] };
    }
    switch (last.name) {
      case "get_incident":
        return "Mock Neo: I looked at that alert. See the tool result for what happened.";
      case "analyze_email":
        return `Mock Neo: I checked that email. See the tool result for the evidence.\n\n${verdictBlock("email")}`;
      case "analyze_sms":
        return `Mock Neo: I checked that text message. See the tool result for the evidence.\n\n${verdictBlock("sms")}`;
      case "get_playbook":
        return "<!-- playbook:clicked_link -->\nMock Neo: here is the first step. Do not enter anything else on that page.";
      case "pending_signin_alerts":
        return "Mock Neo: I looked for sign-in alerts waiting for an answer. See the tool result.";
      default:
        return `Mock Neo: I checked that link. See the tool result for the evidence.\n\n${verdictBlock("url")}`;
    }
  });
}

/** Neo's own sentence, in place of a model call that must not happen (over a cap, or the usage store is down). */
export function refusalModel(text: string) {
  return mockModel({ modelId: REFUSAL_MODEL_ID, respond: () => ({ text, usage: { inputTokens: 0, outputTokens: 0 } }) });
}

/**
 * Which model answers the next model call, per caller (the old chat's `routeForTurn`, `_specs/model-routing.md`):
 * the caller's own routing preference and model family decide the tier's model, the tier comes from
 * `routeTurn` (Jev, or rules), and Haiku 4.5 gets neither thinking nor effort.
 *
 * - The caller is the verified one (`ctx.session.auth.current`, set by agent/lib/app-session.ts); the
 *   preferences are read for exactly that tenant and user, never from input.
 * - eve runs this before every model call. The cap check and the route are memoized for the turn: a
 *   pause for approval or a second model call is not a new check, Jev runs once, and the model does
 *   not change mid-turn.
 * - Over a cap (or the usage store down: fail closed) the turn is answered by the canned refusal.
 * - No household caller exists only on a local dev server (`localDev()`); it gets the medium rung and no metering.
 */
export async function chooseModel(ctx: DynamicModelContext): Promise<ModelSelection> {
  const caller = tenantCallerOf(ctx.session.auth.current);
  const turnId = ctx.turn?.id ?? null;
  if (caller) {
    const gate = await ctx.memo<TurnGate>(["usage-gate", turnId], () => gateTurn(caller));
    if (!gate.ok) return { model: refusalModel(gate.text), modelContextWindowTokens: CONTEXT_WINDOW_TOKENS };
  }
  if (process.env.MOCK_MODE === "true") {
    // The mock isn't in the AI Gateway catalog, so eve needs its context window spelled out.
    return { model: scriptedModel(), modelContextWindowTokens: CONTEXT_WINDOW_TOKENS };
  }
  if (!caller) {
    const medium = anthropicModelFor("medium");
    return selectionForRoute({ model: medium.id, effort: "medium" });
  }
  const route = await ctx.memo<Route>(["route", turnId], async ({ abortSignal }) => {
    const prefs = await getMemberPreferences(caller.tenantId, caller.userId);
    return routeTurn({
      text: turnText(ctx),
      hasAttachment: false,
      attachmentKind: null,
      priorTurns: Math.max(0, turns(ctx.view).length - 1),
      previousVerdict: null,
      playbook: null,
      preference: prefs.routingPreference,
      family: prefs.modelFamily,
      signal: abortSignal,
    });
  });
  return selectionForRoute(route);
}
