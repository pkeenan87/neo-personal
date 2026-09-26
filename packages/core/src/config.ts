/**
 * Environment-driven configuration. Every value is read lazily (at call
 * time, not module load) so tests and long-lived processes can change env
 * without re-importing, and importing @neo/core never requires any env.
 */

/** A read-only view of environment variables (defaults to `process.env`). */
export type EnvSource = Record<string, string | undefined>;

export const DEFAULT_AGENT_MODEL = "claude-opus-5";
export const DEFAULT_COMPRESSION_MODEL = "claude-haiku-4-5";
export const DEFAULT_MAX_TOKENS = 16_000;
export const DEFAULT_EFFORT = "medium" as const;

/** Beta header for the scalar `fallbacks: "default"` form (claude-api skill, Opus 5 migration). */
export const SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-07-01" as const;

export function agentModel(): string {
  return nonEmpty(process.env.NEO_AGENT_MODEL) ?? DEFAULT_AGENT_MODEL;
}

export function compressionModel(): string {
  return nonEmpty(process.env.NEO_COMPRESSION_MODEL) ?? DEFAULT_COMPRESSION_MODEL;
}

/** `NEO_ENABLE_FALLBACKS` — on unless explicitly `false` / `0` / `off` / `no`. */
export function fallbacksEnabled(): boolean {
  const raw = nonEmpty(process.env.NEO_ENABLE_FALLBACKS)?.toLowerCase();
  if (raw === undefined) return true;
  return !["false", "0", "off", "no"].includes(raw);
}

/** Rough chars-per-token ratio used by every local token estimate. */
export const CHARS_PER_TOKEN = 3.5;

/**
 * Hard ceiling on the estimated input tokens sent per request (after
 * compression). Opus 5 has a 1M window, but Neo is a consumer product:
 * the ceiling is a cost bound, not a capability bound.
 */
export function maxInputTokens(): number {
  return positiveInt(process.env.NEO_CONTEXT_MAX_INPUT_TOKENS, 180_000);
}

/** Per-tool-result cap applied inside `wrapToolResult` (in-memory truncation). */
export function toolResultMaxTokens(): number {
  return positiveInt(process.env.NEO_TOOL_RESULT_MAX_TOKENS, 25_000);
}

/** Upper bound on what the Haiku compression call itself is sent. */
export const COMPRESSION_INPUT_MAX_TOKENS = 150_000;
/** Messages at the tail of the conversation that are never compressed. */
export const PRESERVED_RECENT_MESSAGES = 10;

// ─────────────────────────────────────────────────────────────
//  AI Gateway (Phase 2, `_specs/model-routing.md`)
// ─────────────────────────────────────────────────────────────

export const AI_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh";
const TRUTHY = new Set(["true", "1", "yes", "on"]);

/** `NEO_MODEL_GATEWAY` is truthy and `AI_GATEWAY_API_KEY` is set. */
export function gatewayEnabled(source: EnvSource = process.env): boolean {
  const flag = nonEmpty(source.NEO_MODEL_GATEWAY)?.toLowerCase();
  return flag !== undefined && TRUTHY.has(flag) && nonEmpty(source.AI_GATEWAY_API_KEY) !== undefined;
}

/** `NEO_GATEWAY_REGION`: `us` (default, pinned and verifiable) or `global`. */
export function gatewayRegion(source: EnvSource = process.env): "us" | "global" {
  return nonEmpty(source.NEO_GATEWAY_REGION)?.toLowerCase() === "global" ? "global" : "us";
}

const FAMILY_VALUES = ["anthropic", "openai", "kimi", "grok"] as const;

/**
 * `NEO_MODEL_FAMILIES`: comma-separated families members may choose. Default
 * `anthropic`, which is always included; unknown names are ignored.
 */
export function enabledFamilies(source: EnvSource = process.env): Array<(typeof FAMILY_VALUES)[number]> {
  const raw = nonEmpty(source.NEO_MODEL_FAMILIES);
  const out = new Set<(typeof FAMILY_VALUES)[number]>(["anthropic"]);
  for (const part of raw?.split(",") ?? []) {
    const v = part.trim().toLowerCase();
    if ((FAMILY_VALUES as readonly string[]).includes(v)) out.add(v as (typeof FAMILY_VALUES)[number]);
  }
  return FAMILY_VALUES.filter((f) => out.has(f));
}

function nonEmpty(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
