/**
 * Chat-turn router (Phase 2, `_specs/model-routing.md` "Router").
 *
 * Classifies a chat turn into a tier (small / medium / large) with Jev
 * (`typesafe-ai/jev` through AI Gateway, via AI SDK 7 `experimental_evaluate`)
 * and turns it into a concrete route with `resolveRoute`. Jev only ever sees a
 * redacted excerpt of the latest user message plus structural signals, never
 * the raw conversation. Any Jev failure (error, 1.5 s timeout, no ZDR
 * provider) falls back to a deterministic rule tier, so routing never blocks a
 * turn. Playbook turns skip Jev and are pinned to the large tier.
 *
 * `NEO_ROUTER=jev|rules|off` (default `jev` when the gateway is on, otherwise
 * `rules`; `MOCK_MODE` forces `rules`). `NEO_ROUTER_ZDR=false` lets the owner
 * opt out of requiring zero data retention on the Jev call.
 */
import {
  gatewayEnabled,
  logger,
  pinnedRoute,
  resolveRoute,
  type ModelFamily,
  type Route,
  type RouteSignals,
  type RouterKind,
  type RoutingPreference,
  type Tier,
} from "@neo/core";
import type { VerdictLabel } from "@neo/verdict";
import { experimental_evaluate } from "ai";
import type { PlaybookId } from "@/lib/playbooks";

export interface RouteTurnInput {
  text: string;
  hasAttachment: boolean;
  attachmentKind: "email" | "image" | "text" | null;
  priorTurns: number;
  previousVerdict: VerdictLabel | null;
  playbook: PlaybookId | null;
  preference: RoutingPreference;
  family: ModelFamily;
  signal?: AbortSignal;
}

/** Score answer as returned by `experimental_evaluate` (probabilities keyed "0".."2"). */
export interface JevScoreAnswer {
  type: "score";
  score: number;
  probabilities?: Record<string, number>;
}

/** Boolean answer: `probability` is the model-estimated P(true). */
export interface JevBooleanAnswer {
  type: "boolean";
  probability: number;
}

export interface JevAnswers {
  complexity: JevScoreAnswer;
  stakes: JevScoreAnswer;
  needs_tools: JevBooleanAnswer;
}

/** The subset of `experimental_evaluate` the router uses; replaceable in tests. */
export type EvaluateFn = (options: {
  model: string;
  state: { message: string; has_attachment: boolean; attachment_kind: string | null; prior_turns: number; previous_verdict: string | null };
  questions: typeof JEV_QUESTIONS;
  providerOptions: { gateway: { zeroDataRetention: boolean } };
  abortSignal: AbortSignal;
  maxRetries: number;
}) => PromiseLike<{ answers: JevAnswers; providerMetadata?: Record<string, Record<string, unknown> | undefined> }>;

type Env = Record<string, string | undefined>;

export const JEV_MODEL = "typesafe-ai/jev";
export const JEV_TIMEOUT_MS = 1500;
const CONFIDENCE_FLOOR = 0.6;
const NEEDS_TOOLS_THRESHOLD = 0.5;
const MAX_ROUTING_CHARS = 4000;
const LONG_MESSAGE_CHARS = 240;

export const JEV_QUESTIONS = {
  complexity: {
    type: "score",
    instructions: "How much reasoning does answering this message take?",
    criteria: [
      "A greeting, thanks, yes/no, or a one-line follow-up",
      "Check or explain one thing: a link, an email, a text message, a setting, a concept",
      "A multi-step investigation, several artifacts, conflicting evidence, an unfolding incident, or an ambiguous request that needs clarifying",
    ],
  },
  stakes: {
    type: "score",
    instructions: "What is at stake if the answer is wrong?",
    criteria: [
      "Curiosity; no action will follow",
      "The person will act on the answer: click, reply, ignore, or change a setting",
      "Money, credentials or an account are already at risk, or a device may be compromised",
    ],
  },
  needs_tools: {
    type: "boolean",
    instructions: "Does the message reference something Neo can analyze: a URL, a forwarded email or text message, or an attachment?",
  },
} as const;

// ─────────────────────────────────────────────────────────────
//  Redaction
// ─────────────────────────────────────────────────────────────

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;
/** Candidate phone numbers: digits with optional separators; masked only with 7+ digits. */
const PHONE_RE = /\+?\(?\d[\d\s().-]{5,}\d/g;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Second-level labels under which registrations sit one level deeper (a small, common subset). */
const TWO_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "net.uk", "ltd.uk", "plc.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "co.nz", "org.nz", "net.nz",
  "co.jp", "ne.jp", "or.jp",
  "co.in", "net.in", "org.in",
  "co.za", "org.za",
  "co.kr", "or.kr",
  "com.br", "com.mx", "com.cn", "com.hk", "com.sg", "com.tr", "com.ar", "com.tw", "com.my", "com.ph",
]);

/** Registrable domain of a URL (scheme, userinfo, port, path and query stripped). */
function registrableDomain(url: string): string {
  let host = url.replace(/^[a-z]+:\/\//i, "");
  host = host.split(/[/?#]/, 1)[0] ?? "";
  host = host.slice(host.lastIndexOf("@") + 1);
  host = host.replace(/:\d*$/, "").replace(/\.+$/, "").toLowerCase();
  if (!host || IPV4_RE.test(host) || host.startsWith("[")) return host;
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  return labels.slice(TWO_PART_SUFFIXES.has(lastTwo) ? -3 : -2).join(".");
}

function digitCount(s: string): number {
  return s.replace(/\D/g, "").length;
}

/**
 * The only form of the user's message Jev sees: URLs reduced to their
 * registrable domain, email addresses and phone numbers masked, whitespace
 * collapsed, capped at 4000 characters.
 */
export function redactForRouting(text: string): string {
  // URLs become placeholders first so their digits and `@` are not re-masked.
  const domains: string[] = [];
  let out = text.replace(URL_RE, (match) => {
    // Sentence punctuation after a URL stays in the text.
    const trailing = /[.,;:!?)\]]+$/.exec(match)?.[0] ?? "";
    domains.push(registrableDomain(match.slice(0, match.length - trailing.length)));
    return `\u0000${domains.length - 1}\u0000${trailing}`;
  });
  out = out.replace(EMAIL_RE, "[email]");
  out = out.replace(PHONE_RE, (m) => (digitCount(m) >= 7 ? "[phone]" : m));
  out = out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => domains[Number(i)] ?? "");
  out = out.replace(/\s+/g, " ").trim();
  return out.slice(0, MAX_ROUTING_CHARS);
}

// ─────────────────────────────────────────────────────────────
//  Rules (deterministic fallback)
// ─────────────────────────────────────────────────────────────

const INCIDENT_RE =
  /\b(?:hacked|drained|stolen|ransom\w*|passwords?|passcodes?|gift ?cards?|wire[ds]?|transfer\w*|compromised|locked out|2fa|verification codes?|bitcoin|crypto\w*|social security|ssn)\b/;
const BARE_DOMAIN_RE = /\b(?:[a-z0-9-]+\.)+[a-z]{2,24}(?:\/\S*)?\b/i;

function hasPhone(text: string): boolean {
  return (text.match(PHONE_RE) ?? []).some((m) => digitCount(m) >= 7);
}

/** Deterministic tier from keywords and structure; used when Jev is off or fails. */
export function rulesTier(input: RouteTurnInput): Tier {
  const text = input.text.trim().toLowerCase();
  if (INCIDENT_RE.test(text) || input.previousVerdict === "malicious") return "large";
  if (
    input.hasAttachment ||
    input.previousVerdict === "suspicious" ||
    text.length > LONG_MESSAGE_CHARS ||
    new RegExp(URL_RE.source, "i").test(text) ||
    BARE_DOMAIN_RE.test(text) ||
    new RegExp(EMAIL_RE.source, "i").test(text) ||
    hasPhone(text)
  ) {
    return "medium";
  }
  return "small";
}

// ─────────────────────────────────────────────────────────────
//  Jev decision
// ─────────────────────────────────────────────────────────────

const TIER_BY_LEVEL: readonly Tier[] = ["small", "medium", "large"];

/** Highest-probability level (0..2); the rounded score when there is no distribution. */
function level(answer: JevScoreAnswer): number {
  let best: number | undefined;
  let bestP = Number.NEGATIVE_INFINITY;
  for (const [key, p] of Object.entries(answer.probabilities ?? {})) {
    const lvl = Number(key);
    if (!Number.isInteger(lvl) || !Number.isFinite(p)) continue;
    if (p > bestP) {
      best = lvl;
      bestP = p;
    }
  }
  const raw = best ?? Math.round(answer.score);
  return Math.min(2, Math.max(0, Number.isFinite(raw) ? raw : 1));
}

/**
 * Tier from Jev's answers: `max(complexity, stakes)`; when `needsToolsFloor`
 * is set, `needs_tools` (P >= 0.5) lifts small to medium; missing or low
 * (< 0.6) confidence on either score lifts to at least medium.
 */
export function decideTier(
  answers: JevAnswers,
  confidence: Record<string, number> | undefined,
  needsToolsFloor: boolean,
): { tier: Tier; signals: RouteSignals } {
  const complexity = level(answers.complexity);
  const stakes = level(answers.stakes);
  const needsTools = answers.needs_tools.probability >= NEEDS_TOOLS_THRESHOLD;
  let idx = Math.max(complexity, stakes);
  if (needsToolsFloor && needsTools && idx < 1) idx = 1;

  const c = confidence?.complexity;
  const s = confidence?.stakes;
  const confident = typeof c === "number" && typeof s === "number" && c >= CONFIDENCE_FLOOR && s >= CONFIDENCE_FLOOR;
  if (!confident && idx < 1) idx = 1;
  const known = [c, s].filter((v): v is number => typeof v === "number" && Number.isFinite(v));

  return {
    tier: TIER_BY_LEVEL[idx]!,
    signals: {
      complexity,
      stakes,
      needsTools,
      ...(known.length > 0 ? { confidence: Math.min(...known) } : {}),
      reason: `Jev: complexity ${complexity}/2, stakes ${stakes}/2`,
    },
  };
}

// ─────────────────────────────────────────────────────────────
//  routeTurn
// ─────────────────────────────────────────────────────────────

type RouterMode = "jev" | "rules" | "off";

function routerMode(env: Env): RouterMode {
  const mock = env.MOCK_MODE === "true" || env.MOCK_MODE === "1";
  if (mock) return "rules";
  const raw = env.NEO_ROUTER?.trim().toLowerCase();
  if (raw === "jev" || raw === "rules" || raw === "off") return raw;
  return gatewayEnabled(env) ? "jev" : "rules";
}

class RouterTimeoutError extends Error {
  override name = "RouterTimeoutError";
}

/** Error category safe to log (never the provider's message text). */
function errorType(err: unknown): string {
  if (err instanceof RouterTimeoutError) return "timeout";
  const e = err as { name?: unknown; type?: unknown; code?: unknown; message?: unknown } | null;
  const blob = [e?.type, e?.code, e?.message].map((v) => (typeof v === "string" ? v : "")).join(" ");
  if (blob.includes("no_providers_available")) return "no_providers_available";
  if (e?.name === "AbortError") return "aborted";
  return typeof e?.name === "string" && /^[A-Za-z_]{1,64}$/.test(e.name) ? e.name : "unknown";
}

async function callJev(input: RouteTurnInput, evaluate: EvaluateFn, env: Env) {
  const controller = new AbortController();
  const signal = input.signal ? AbortSignal.any([controller.signal, input.signal]) : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  // Settle on timeout or caller abort even if the evaluate implementation ignores the signal.
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new RouterTimeoutError("Jev timed out"));
    }, JEV_TIMEOUT_MS);
    onAbort = () => reject(input.signal?.reason ?? new DOMException("Aborted", "AbortError"));
    if (input.signal?.aborted) onAbort();
    else input.signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([
      evaluate({
        model: JEV_MODEL,
        state: {
          message: redactForRouting(input.text),
          has_attachment: input.hasAttachment,
          attachment_kind: input.attachmentKind,
          prior_turns: input.priorTurns,
          previous_verdict: input.previousVerdict,
        },
        questions: JEV_QUESTIONS,
        providerOptions: { gateway: { zeroDataRetention: env.NEO_ROUTER_ZDR !== "false" } },
        abortSignal: signal,
        // One attempt: the 1.5 s budget leaves no room for retries, and the rules fallback is cheap.
        maxRetries: 0,
      }),
      guard,
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) input.signal?.removeEventListener("abort", onAbort);
    guard.catch(() => {});
  }
}

function readConfidence(meta: Record<string, Record<string, unknown> | undefined> | undefined): Record<string, number> | undefined {
  const raw = meta?.typesafe?.confidence;
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

const defaultEvaluate: EvaluateFn = (options) =>
  experimental_evaluate(options);

/** Route one chat turn. Never throws for a Jev failure; the rules tier is the fallback. */
export async function routeTurn(
  input: RouteTurnInput,
  deps: { evaluate?: EvaluateFn; now?: () => number; env?: Env } = {},
): Promise<Route> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const started = now();
  const { preference, family } = input;

  const finish = (route: Route): Route => {
    logger.info("Turn routed", "router", {
      tier: route.tier,
      router: route.router,
      confidence: route.signals?.confidence,
      family: route.family,
      preference: route.preference,
      model: route.model,
      durationMs: now() - started,
    });
    return route;
  };
  const byRule = (tier: Tier, reason: string, router: RouterKind = "rule"): Route =>
    resolveRoute({ tier, preference, family, router, signals: { reason }, source: env });

  if (input.playbook) {
    return finish({ ...pinnedRoute("playbook", env), preference, signals: { reason: "Playbook" } });
  }

  const mode = routerMode(env);
  if (mode === "off") return finish(byRule("medium", "Router off"));
  if (mode === "rules") return finish(byRule(rulesTier(input), "Rules"));

  let decision: ReturnType<typeof decideTier>;
  try {
    const result = await callJev(input, deps.evaluate ?? defaultEvaluate, env);
    decision = decideTier(result.answers, readConfidence(result.providerMetadata), true);
  } catch (err) {
    logger.warn("Jev routing failed; using rules", "router", { errorType: errorType(err), durationMs: now() - started });
    return finish(byRule(rulesTier(input), "Fallback rule"));
  }
  return finish(resolveRoute({ tier: decision.tier, preference, family, router: "jev", signals: decision.signals, source: env }));
}
