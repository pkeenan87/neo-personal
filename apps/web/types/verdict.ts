/**
 * TEMPORARY MIRROR of `Verdict` from `@neo/verdict` (docs/contracts.md).
 *
 * The integration pass deletes this file and replaces imports of
 * `@/types/verdict` with `@neo/verdict` (and `isVerdict` below with
 * `VerdictSchema.safeParse`). Do not extend this type here: change
 * docs/contracts.md and @neo/verdict first.
 */

export type VerdictSubjectType =
  | "email"
  | "sms"
  | "url"
  | "page"
  | "signin_alert"
  | "file"
  | "conversation";

export type VerdictValue = "malicious" | "suspicious" | "likely_safe" | "insufficient_evidence";

export type IndicatorSeverity = "low" | "medium" | "high" | "critical";

export type ActionUrgency = "now" | "soon" | "optional";

export type Verdict = {
  subject_type: VerdictSubjectType;
  verdict: VerdictValue;
  confidence: number; // 0..1
  headline: string; // one sentence for the user
  indicators: { severity: IndicatorSeverity; category: string; evidence: string; explanation: string }[];
  recommended_actions: { action: string; urgency: ActionUrgency; deep_link?: string }[];
  iocs: { urls: string[]; domains: string[]; ips: string[]; hashes: string[]; phone_numbers: string[] };
  raw_ref?: string; // artifact id
};

const SUBJECT_TYPES: readonly string[] = ["email", "sms", "url", "page", "signin_alert", "file", "conversation"];
const VERDICTS: readonly string[] = ["malicious", "suspicious", "likely_safe", "insufficient_evidence"];
const SEVERITIES: readonly string[] = ["low", "medium", "high", "critical"];
const URGENCIES: readonly string[] = ["now", "soon", "optional"];
const IOC_KEYS = ["urls", "domains", "ips", "hashes", "phone_numbers"] as const;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === "string");
}

/**
 * Structural validator for the mirror. TEMPORARY: replaced by
 * `VerdictSchema.safeParse(v).success` from @neo/verdict.
 */
export function isVerdict(v: unknown): v is Verdict {
  if (!isObject(v)) return false;
  if (typeof v.subject_type !== "string" || !SUBJECT_TYPES.includes(v.subject_type)) return false;
  if (typeof v.verdict !== "string" || !VERDICTS.includes(v.verdict)) return false;
  if (typeof v.confidence !== "number" || !(v.confidence >= 0 && v.confidence <= 1)) return false;
  if (typeof v.headline !== "string") return false;
  if (v.raw_ref !== undefined && typeof v.raw_ref !== "string") return false;

  if (!Array.isArray(v.indicators)) return false;
  for (const i of v.indicators) {
    if (!isObject(i)) return false;
    if (typeof i.severity !== "string" || !SEVERITIES.includes(i.severity)) return false;
    if (typeof i.category !== "string" || typeof i.evidence !== "string" || typeof i.explanation !== "string") {
      return false;
    }
  }

  if (!Array.isArray(v.recommended_actions)) return false;
  for (const a of v.recommended_actions) {
    if (!isObject(a)) return false;
    if (typeof a.action !== "string") return false;
    if (typeof a.urgency !== "string" || !URGENCIES.includes(a.urgency)) return false;
    if (a.deep_link !== undefined && typeof a.deep_link !== "string") return false;
  }

  if (!isObject(v.iocs)) return false;
  for (const k of IOC_KEYS) {
    if (!isStringArray(v.iocs[k])) return false;
  }
  return true;
}
