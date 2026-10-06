/**
 * One sender-allowlisted candidate: fetch `internetMessageHeaders` plus the body, run normal `analyzeEmail`, then the
 * step-4 sign-in path (`finalizeSigninVerdict`). Parsed events go only to step 4's `signin_events` with
 * `source: "outlook"`. A message that matches an alert format without a passing, allowlisted DKIM result in the receiver's
 * own Authentication-Results is recorded `authenticated: false` and never gets a verdict (so never an owner alert).
 * Links in the mail are never followed: `maxUrls: 0` means no `analyzeUrl` fetch, DNS lookup or reputation query for
 * attacker-chosen URLs. Step 4's link rules read `link_summary` hosts, which are extracted without any network access.
 */
import { hashPii, logger } from "@neo/core";
import type { Verdict } from "@neo/verdict";
import { buildRawMessage } from "./candidates";
import type { OutlookDeps } from "./deps";
import type { OutlookGraphClient, OutlookRunCtx } from "./types";

export type CandidateOutcome = "not_alert" | "recorded_unauthenticated" | "verdict_saved";

/** Deterministic starting point for a connector-sourced alert: no model call; step 4's rules decide the label. */
function baselineVerdict(): Verdict {
  return {
    subject_type: "signin_alert",
    verdict: "insufficient_evidence",
    confidence: 0.3,
    headline: "Neo checked a sign-in alert in your Outlook.com inbox.",
    indicators: [],
    recommended_actions: [{ action: "If you did not just sign in, open the provider's official app or website yourself and review your account activity.", urgency: "soon" }],
    iocs: { urls: [], domains: [], ips: [], hashes: [], phone_numbers: [] },
  };
}

export async function processCandidate(ctx: OutlookRunCtx, graph: OutlookGraphClient, messageId: string, deps: OutlookDeps): Promise<CandidateOutcome> {
  const message = await graph.getCandidateMessage(messageId);
  const analysis = await deps.analyzeEmail({ raw: buildRawMessage(message) }, { maxUrls: 0 });
  if (!analysis.signin_alert) return "not_alert";
  const finalized = await deps.finalizeSignin({ tenantId: ctx.tenantId, userId: ctx.userId, analysis, verdict: baselineVerdict(), source: "outlook" });
  const event = finalized.event;
  if (!event) return "not_alert";
  if (!event.authenticated) {
    await deps.persistSignin({ tenantId: ctx.tenantId, userId: ctx.userId, event });
    return "recorded_unauthenticated";
  }
  // Authenticated: the deterministic verdict is stored for the member (and alerts the owner only when it is malicious or suspicious).
  let verdictId: string | undefined;
  try {
    verdictId = (await deps.saveVerdict({ tenantId: ctx.tenantId, userId: ctx.userId, source: "inbound", verdict: finalized.verdict })).id;
  } catch (err) {
    logger.error("Outlook sign-in verdict save failed", "outlook", { tenantId: ctx.tenantId, userIdHash: hashPii(ctx.userId), errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
  }
  await deps.persistSignin({ tenantId: ctx.tenantId, userId: ctx.userId, verdictId, event });
  return verdictId ? "verdict_saved" : "not_alert";
}
