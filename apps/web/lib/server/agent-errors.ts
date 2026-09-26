/**
 * Classification of model API errors for the agent routes (Phase 2, _specs/model-routing.md
 * "Budget and errors"). Duck-typed so it works on `Anthropic.APIError` instances without
 * importing the SDK, and on plain objects in tests.
 */

/** User-safe text shown when the AI Gateway budget for Neo's key is exhausted. */
export const BUDGET_EXHAUSTED_MESSAGE = "Neo's monthly AI budget is used up. Please try again after it resets.";

/** Error type AI Gateway returns with HTTP 402 when a budget is exceeded. */
export const BUDGET_EXHAUSTED_ERROR_TYPE = "quota_for_entity_exceeded";

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** `type` of an API error: `err.type` (Anthropic SDK), else `err.error.type` or `err.error.error.type` (raw body). */
function errorType(err: Record<string, unknown>): unknown {
  if (typeof err.type === "string") return err.type;
  const body = err.error;
  if (!isObj(body)) return undefined;
  if (typeof body.type === "string" && body.type !== "error") return body.type;
  return isObj(body.error) ? body.error.type : undefined;
}

/**
 * True for an AI Gateway budget error: HTTP 402, or an error whose type is
 * `quota_for_entity_exceeded` (e.g. a mid-stream error event without a status).
 */
export function isBudgetExhaustedError(err: unknown): boolean {
  if (!isObj(err)) return false;
  if (err.status === 402) return true;
  return errorType(err) === BUDGET_EXHAUSTED_ERROR_TYPE;
}
