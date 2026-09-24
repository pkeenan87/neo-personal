/**
 * Environment-driven configuration. Every value is read lazily (at call
 * time, not module load) so tests and long-lived processes can change env
 * without re-importing, and importing @neo/core never requires any env.
 */

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

function nonEmpty(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
