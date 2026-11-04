/**
 * The eve chat's `confirm_signin` logic: "Was this you?" answered from the chat. Imports nothing from
 * Next, so the eve server can bundle it.
 *
 * - The caller (tenant, user) is the verified eve caller, never tool input. Membership is re-read from
 *   the database at this moment, so a member removed since the session was issued is refused.
 * - The subject rule is the one the card uses (`answerSigninCheck`): only the verdict's own member may
 *   answer; an owner, another member and a foreign household all get `not_found`.
 * - Success is reported only after the answer is stored.
 */
import { hashPii, logger } from "@neo/core";
import { recordAudit } from "../audit";
import { currentHouseholdRole } from "../household-admin";
import { VERDICT_ID_RE } from "../verdict-data";
import { answerSigninCheck } from "./service";

export interface SigninAnswerCaller {
  tenantId: string;
  userId: string;
}

export type ConfirmSigninResult =
  | { ok: true; wasMe: boolean; message: string; playbook?: "account_takeover" }
  | { ok: false; error: "not_found" | "no_signin_check" | "not_allowed" | "failed"; message: string };

const NOT_FOUND: ConfirmSigninResult = { ok: false, error: "not_found", message: "Neo cannot find that sign-in alert." };

export async function confirmSignin(caller: SigninAnswerCaller, verdictId: string, wasMe: boolean): Promise<ConfirmSigninResult> {
  try {
    const role = await currentHouseholdRole({ tenantId: caller.tenantId, userId: caller.userId });
    if (!role) return { ok: false, error: "not_allowed", message: "Only a member of this household can answer." };
    if (!VERDICT_ID_RE.test(verdictId)) return NOT_FOUND;
    const result = await answerSigninCheck({ tenantId: caller.tenantId, userId: caller.userId, role }, verdictId, wasMe ? "yes" : "no");
    if (result.status === "not_found") return NOT_FOUND;
    if (result.status === "no_check") return { ok: false, error: "no_signin_check", message: "That alert has no sign-in question to answer." };
    await recordAudit(caller.tenantId, caller.userId, "signin.answered", { verdictId, wasMe, via: "eve_chat" });
    return wasMe
      ? { ok: true, wasMe, message: "Got it. Neo will treat that device as yours from now on." }
      : {
          ok: true,
          wasMe,
          playbook: "account_takeover",
          message: "Thanks for telling me. Neo will not treat that device as yours. Let's secure your account now.",
        };
  } catch (err) {
    logger.error("Sign-in answer failed", "signin", {
      tenantId: caller.tenantId,
      userIdHash: hashPii(caller.userId),
      errorMessage: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
    });
    return { ok: false, error: "failed", message: "Neo could not save that answer. Nothing was changed." };
  }
}
