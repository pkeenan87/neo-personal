import { z } from "zod";

export const SUBJECT_TYPES = ["email", "sms", "url", "page", "signin_alert", "file", "conversation"] as const;
export const VERDICTS = ["malicious", "suspicious", "likely_safe", "insufficient_evidence"] as const;
export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export const URGENCIES = ["now", "soon", "optional"] as const;

export type SubjectType = (typeof SUBJECT_TYPES)[number];
export type VerdictLabel = (typeof VERDICTS)[number];
export type Severity = (typeof SEVERITIES)[number];
export type Urgency = (typeof URGENCIES)[number];

export type Verdict = {
  subject_type: SubjectType;
  verdict: VerdictLabel;
  /** 0..1 */
  confidence: number;
  /** one sentence for the user */
  headline: string;
  indicators: { severity: Severity; category: string; evidence: string; explanation: string }[];
  recommended_actions: { action: string; urgency: Urgency; deep_link?: string }[];
  iocs: { urls: string[]; domains: string[]; ips: string[]; hashes: string[]; phone_numbers: string[] };
  /** artifact id */
  raw_ref?: string;
};

const IndicatorSchema = z
  .object({
    severity: z.enum(SEVERITIES),
    category: z.string().describe("Short machine-friendly category, e.g. lookalike_domain, young_domain, credential_form"),
    evidence: z.string().describe("The concrete observed fact (quote or value)"),
    explanation: z.string().describe("Why this matters, in plain language for a non-expert"),
  })
  .strict();

const ActionSchema = z
  .object({
    action: z.string().describe("Imperative instruction for the user"),
    urgency: z.enum(URGENCIES),
    deep_link: z.string().optional().describe("Optional link that performs or helps with the action"),
  })
  .strict();

const IocsSchema = z
  .object({
    urls: z.array(z.string()),
    domains: z.array(z.string()),
    ips: z.array(z.string()),
    hashes: z.array(z.string()),
    phone_numbers: z.array(z.string()),
  })
  .strict();

export const VerdictSchema: z.ZodType<Verdict> = z
  .object({
    subject_type: z.enum(SUBJECT_TYPES),
    verdict: z.enum(VERDICTS),
    confidence: z.number().min(0).max(1).describe("Confidence in the verdict, from 0 to 1 inclusive"),
    headline: z.string().min(1).describe("One sentence for the user"),
    indicators: z.array(IndicatorSchema),
    recommended_actions: z.array(ActionSchema),
    iocs: IocsSchema,
    raw_ref: z.string().optional().describe("Stored artifact id this verdict refers to"),
  })
  .strict();

/** Keywords Claude structured outputs / strict tools do not accept; the zod schema still enforces them client-side. */
const UNSUPPORTED_KEYWORDS = new Set(["$schema", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "pattern", "minItems", "maxItems"]);

function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitize);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (UNSUPPORTED_KEYWORDS.has(k)) continue;
    out[k] = sanitize(v);
  }
  if (out.type === "object" || "properties" in out) out.additionalProperties = false;
  return out;
}

/**
 * JSON Schema for the Verdict, usable as a Claude structured-output format
 * (`output_config.format`) or a strict tool `input_schema`: every object has
 * `additionalProperties: false`, and unsupported numeric/string constraints are
 * removed (validate the result with `VerdictSchema` to enforce them).
 */
export const verdictJsonSchema: Record<string, unknown> = sanitize(
  z.toJSONSchema(VerdictSchema, { target: "draft-2020-12", io: "output" }),
) as Record<string, unknown>;

const VERDICT_RANK: Record<VerdictLabel, number> = {
  malicious: 3,
  suspicious: 2,
  insufficient_evidence: 1,
  likely_safe: 0,
};

const SEVERITY_RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3, critical: 4 };

/**
 * Sortable rank. Given a Verdict, ranks by verdict label (malicious 3 > suspicious 2 >
 * insufficient_evidence 1 > likely_safe 0). Given a verdict label or indicator severity string,
 * ranks that value (severity: low 1 .. critical 4). Higher is worse.
 */
export function verdictSeverityRank(v: Verdict | VerdictLabel | Severity): number {
  if (typeof v === "object") return VERDICT_RANK[v.verdict];
  if (v in VERDICT_RANK) return VERDICT_RANK[v as VerdictLabel];
  return SEVERITY_RANK[v as Severity] ?? 0;
}

const LABELS: Record<VerdictLabel, string> = {
  malicious: "MALICIOUS",
  suspicious: "SUSPICIOUS",
  likely_safe: "LIKELY SAFE",
  insufficient_evidence: "INSUFFICIENT EVIDENCE",
};

/** One line: `[MALICIOUS 92%] url: headline (3 indicators, top: high lookalike_domain)` */
export function summarizeVerdict(v: Verdict): string {
  const pct = Math.round(Math.min(1, Math.max(0, v.confidence)) * 100);
  const top = [...v.indicators].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])[0];
  const n = v.indicators.length;
  const detail = top ? ` (${n} indicator${n === 1 ? "" : "s"}, top: ${top.severity} ${top.category})` : "";
  const headline = v.headline.replace(/\s+/g, " ").trim();
  return `[${LABELS[v.verdict]} ${pct}%] ${v.subject_type}: ${headline}${detail}`;
}
