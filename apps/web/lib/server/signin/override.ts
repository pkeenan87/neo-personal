/**
 * Deterministic post-triage override for sign-in alerts (_specs/signin-alerts.md). Pure: it takes the
 * EmailAnalysis (with its `signin_alert`) and the model's triage Verdict and returns the Verdict to store.
 *
 *   fake-alert rule fires                          -> malicious
 *   verified template + every safe gate passes     -> likely_safe
 *   authentication absent (forwarded/pasted)       -> insufficient_evidence (never safe; a suspicious or
 *                                                     malicious triage verdict is kept, not softened)
 *   otherwise                                      -> the triage verdict, capped at suspicious
 *
 * Every string it adds is static text keyed by enums (never parsed message values), because verdicts reach
 * owner alerts and notification email.
 */
import type { EmailAnalysis, SigninFakeRule } from "@neo/tools";
import { assessSigninAlert } from "@neo/tools";
import type { Verdict } from "@neo/verdict";
import { PROVIDER_NAMES } from "@/lib/signin-providers";

export { PROVIDER_NAMES };

const RULE_TEXT: Record<SigninFakeRule, { evidence: string; explanation: string }> = {
  sender_provider_mismatch: {
    evidence: "The sender or its authentication does not match the provider.",
    explanation: "Real alerts are signed by the provider's own domain. This one is not, so it was probably sent by someone pretending to be the provider.",
  },
  off_provider_link: {
    evidence: "A link in the message goes somewhere other than the provider's own domains.",
    explanation: "Real alerts only link to the provider. A link elsewhere is how fake alerts steal passwords.",
  },
  callback_number: {
    evidence: "The message asks you to call a phone number.",
    explanation: "Providers do not ask you to phone a number from a sign-in alert. Callback numbers connect you to scammers.",
  },
  reply_with_code: {
    evidence: "The message asks you to reply with a code or to hand over sign-in details.",
    explanation: "A provider never asks for a code or password by reply. Anyone who has your code can take over your account.",
  },
};

/** The sign-in alert hook never lets a model-written `signin_check` through; the app sets it separately. */
function base(verdict: Verdict): Verdict {
  const { signin_check: _drop, ...rest } = verdict;
  return { ...rest, subject_type: "signin_alert" };
}

function officialAction(name: string): Verdict["recommended_actions"][number] {
  return {
    action: `Check your account by opening the official ${name} app or typing its address yourself. Do not use links in the message.`,
    urgency: "now",
  };
}

/** `templates` overrides the shipped verified-flag registry (tests only). */
export function applySigninAlertOverride(input: { analysis: EmailAnalysis; verdict: Verdict; templates?: readonly { id: string; verified: boolean }[] }): Verdict {
  const { analysis, verdict } = input;
  const a = input.templates ? assessSigninAlert(analysis, input.templates) : assessSigninAlert(analysis);
  if (!a) return verdict;
  const v = base(verdict);
  const name = PROVIDER_NAMES[a.provider];

  if (a.fake_rules.length > 0) {
    return {
      ...v,
      verdict: "malicious",
      confidence: Math.max(v.confidence, 0.95),
      headline: `This ${name} sign-in alert looks fake. Do not click, call or reply.`,
      indicators: [
        ...a.fake_rules.map((rule) => ({ severity: "high" as const, category: rule, ...RULE_TEXT[rule] })),
        ...v.indicators,
      ],
      recommended_actions: [
        { action: "Do not click any link, call any number or reply with any code from this message.", urgency: "now" },
        officialAction(name),
        ...v.recommended_actions,
      ],
    };
  }

  if (a.all_gates_pass && verdict.verdict !== "malicious") {
    return {
      ...v,
      verdict: "likely_safe",
      confidence: Math.min(Math.max(v.confidence, 0.8), 0.9),
      headline: `This looks like a genuine ${name} sign-in alert.`,
      indicators: [
        {
          severity: "low",
          category: "verified_signin_template",
          evidence: "The message matches a known alert format, is signed by the provider's domain, and every link stays on the provider.",
          explanation: "A matching format alone proves nothing; the signature and links are what make this likely genuine.",
        },
        ...v.indicators,
      ],
      recommended_actions: [
        { action: `If you did not just sign in, open the official ${name} app or website yourself and review your account activity.`, urgency: "soon" },
        ...v.recommended_actions,
      ],
    };
  }

  if (a.auth_absent && (v.verdict === "likely_safe" || v.verdict === "insufficient_evidence")) {
    return {
      ...v,
      verdict: "insufficient_evidence",
      confidence: Math.min(v.confidence, 0.5),
      // Static even when the label is unchanged: a model headline may quote the member's device or location.
      headline: `Neo cannot confirm who sent this ${name} alert, because the sender checks were lost when it was forwarded or pasted.`,
      indicators: [
        {
          severity: "low",
          category: "authentication_absent",
          evidence: "No sender authentication results were available for this message.",
          explanation: "Forwarded or pasted copies usually lose them, so Neo cannot tell a real alert from a fake one.",
        },
        ...v.indicators,
      ],
      recommended_actions: [officialAction(name), ...v.recommended_actions],
    };
  }

  // Authentication is present but the safe gates did not all pass (e.g. unverified template): never likely_safe.
  if (v.verdict === "likely_safe") {
    return {
      ...v,
      verdict: "suspicious",
      confidence: Math.min(v.confidence, 0.6),
      headline: `Neo recognizes the format of a ${name} sign-in alert but cannot confirm it is genuine.`,
      indicators: [
        {
          severity: "medium",
          category: "signin_alert_unconfirmed",
          evidence: "The alert format is recognized but not every safety check passed.",
          explanation: "Neo only calls a sign-in alert likely safe when its template is verified, it is signed by the provider and every link stays on the provider.",
        },
        ...v.indicators,
      ],
      recommended_actions: [officialAction(name), ...v.recommended_actions],
    };
  }
  // Same verdict as triage, but the headline is static: it reaches owner alerts, which must not carry the member's device or location.
  const headlines: Record<Verdict["verdict"], string> = {
    malicious: `This ${name} sign-in alert looks dangerous.`,
    suspicious: `Neo recognizes the format of a ${name} sign-in alert but cannot confirm it is genuine.`,
    insufficient_evidence: `Neo cannot confirm who sent this ${name} alert.`,
    likely_safe: `This looks like a genuine ${name} sign-in alert.`,
  };
  return { ...v, headline: headlines[v.verdict] };
}

/**
 * The turn analyzed several emails and the verdict does not say which one it is about, so the sign-in alert
 * rules cannot be applied to it. Never `likely_safe` (capped to `suspicious`), never a `signin_check`, and marked
 * `signin_alert` so owners get the redacted view. Other labels are kept: this never softens a warning.
 */
export function applyAmbiguousSigninCap(verdict: Verdict): Verdict {
  const v = base(verdict);
  // Static headline: the model's may quote a member's device or location, and this verdict reaches owner alerts.
  const headline = "Neo checked more than one message and cannot tell which sign-in alert this verdict is about.";
  if (v.verdict !== "likely_safe") return { ...v, headline };
  return {
    ...v,
    verdict: "suspicious",
    confidence: Math.min(v.confidence, 0.6),
    headline: `${headline} It cannot call any of them safe.`,
    indicators: [
      {
        severity: "medium",
        category: "signin_alert_ambiguous",
        evidence: "More than one message was analyzed in this chat and at least one is a sign-in alert.",
        explanation: "Neo only calls a sign-in alert likely safe after checking that one message on its own. Check each message separately.",
      },
      ...v.indicators,
    ],
    recommended_actions: [
      { action: "Ask Neo about one message at a time, or open the provider's official app or website yourself instead of using links in the messages.", urgency: "soon" },
      ...v.recommended_actions,
    ],
  };
}

/**
 * The sign-in hook threw on a message that is (or may be) a sign-in alert, so the deterministic rules never ran.
 * Fail closed: never `likely_safe` (capped to `suspicious`), never a `signin_check`, marked `signin_alert` so owners
 * get the redacted view. Other labels are kept. The headline is static; no error text or message content enters it.
 */
export function applySigninHookFailureCap(verdict: Verdict): Verdict {
  const v = base(verdict);
  const headline = "Neo could not finish checking this sign-in alert.";
  if (v.verdict !== "likely_safe") return { ...v, headline };
  return {
    ...v,
    verdict: "suspicious",
    confidence: Math.min(v.confidence, 0.6),
    headline: `${headline} It cannot call it safe.`,
    indicators: [
      {
        severity: "medium",
        category: "signin_alert_unconfirmed",
        evidence: "The sign-in alert checks did not complete.",
        explanation: "Neo only calls a sign-in alert likely safe after its own checks pass, so this one is not marked safe.",
      },
      ...v.indicators,
    ],
    recommended_actions: [
      { action: "Open the provider's official app or website yourself and review your account activity. Do not use links in the message.", urgency: "soon" },
      ...v.recommended_actions,
    ],
  };
}
