import { hashPii, logger } from "@neo/core";
import { spendGate } from "@/lib/server/spend-cap";
import { capMessage, checkCaps, noteCapHit } from "@/lib/server/usage";

/** Model id of the canned refusal, so the usage recorder can tell a refused turn from a metered one. */
export const REFUSAL_MODEL_ID = "neo-usage-refusal";

/** eve reports a mock model as `<provider>/<modelId>` (`eve-mock/neo-usage-refusal`) in `model.started`. */
export function isRefusalModel(modelId: string | undefined): boolean {
  return modelId === REFUSAL_MODEL_ID || (modelId?.endsWith(`/${REFUSAL_MODEL_ID}`) ?? false);
}

/** JSON, because a dynamic model's decision is saved as a memo. */
export type TurnGate = { ok: true } | { ok: false; text: string };

/**
 * The old chat's pre-flight (`/api/agent`: `checkCaps`, then 429; the usage store being down is a 503,
 * fail closed), as a decision for one eve turn. Caps are per household. Refused means the turn is
 * answered with `text` by a canned model that spends nothing; the text is Neo's own sentence, never
 * model-written. A turn that is already running (a pause for approval, a second model call) is never
 * re-checked: the caller memoizes this per turn, as a resumption is not a new check.
 */
export async function gateTurn(caller: { tenantId: string; userId: string }): Promise<TurnGate> {
  try {
    const caps = await checkCaps(caller.tenantId);
    if (!caps.allowed && caps.reason) {
      await noteCapHit(caller.tenantId, caller.userId, caps, caps.reason);
      return { ok: false, text: capMessage(caps, caps.reason) };
    }
    // The household's monthly model spend cap (off by default); the refusal text is templated, never model-written.
    const spend = await spendGate(caller.tenantId);
    if (spend.blocked) return { ok: false, text: spend.message };
    return { ok: true };
  } catch (err) {
    logger.error("Usage cap check failed", "eve.chat", {
      tenantId: caller.tenantId,
      userIdHash: hashPii(caller.userId),
      errorMessage: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
    });
    return { ok: false, text: "Neo can't check your usage right now. Please try again in a moment." };
  }
}
