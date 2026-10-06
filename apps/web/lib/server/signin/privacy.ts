/**
 * Owner privacy for member sign-in alerts (_specs/signin-alerts.md). A sign-in alert verdict is about one
 * member's account activity; its model-written text can quote their device, location, IP or account. Anyone
 * but that member sees only the label, severity and static text. Pure and total: no I/O.
 */
import type { Verdict } from "@neo/verdict";

export const SIGNIN_HIDDEN_TEXT = "Sign-in details are visible only to the member.";

const STATIC_HEADLINES: Record<Verdict["verdict"], string> = {
  malicious: "A sign-in alert this member checked looks dangerous.",
  suspicious: "A sign-in alert this member checked looks suspicious.",
  insufficient_evidence: "Neo could not confirm a sign-in alert this member checked.",
  likely_safe: "A sign-in alert this member checked looks genuine.",
};

/** True when `viewerUserId` is not the verdict's own user and the verdict is a sign-in alert. */
export function isForeignSigninAlert(subjectType: string, ownerUserId: string | null | undefined, viewerUserId: string): boolean {
  return subjectType === "signin_alert" && ownerUserId !== viewerUserId;
}

/** The static one-line headline shown to anyone but the member. */
export function signinAlertPublicHeadline(label: Verdict["verdict"]): string {
  return STATIC_HEADLINES[label];
}

/** A category kept only when it looks like a plain snake_case label (it is model-written). */
function safeCategory(c: string): string {
  return /^[a-z0-9_]{1,40}$/.test(c) ? c : "indicator";
}

function origin(u: string): string | undefined {
  try {
    return new URL(u).origin;
  } catch {
    return undefined;
  }
}

/**
 * The verdict as anyone but the member may see it: label, severity, confidence and static text only.
 * Explanations, evidence, recommended actions and the headline are replaced; IP addresses are dropped and URLs
 * reduced to their origin; `signin_check` is removed.
 */
export function redactSigninAlertForOthers(v: Verdict): Verdict {
  const { signin_check: _drop, ...rest } = v;
  return {
    ...rest,
    headline: STATIC_HEADLINES[v.verdict],
    indicators: v.indicators.map((i) => ({
      severity: i.severity,
      category: safeCategory(i.category),
      evidence: SIGNIN_HIDDEN_TEXT,
      explanation: "Neo's checks found something about this sign-in alert. The member can see the details.",
    })),
    recommended_actions: [
      { action: "Ask the member to review the alert in the provider's official app or website, not through links in the message.", urgency: "soon" },
    ],
    iocs: {
      ...v.iocs,
      ips: [],
      urls: [...new Set(v.iocs.urls.map(origin).filter((o): o is string => !!o))],
    },
  };
}
