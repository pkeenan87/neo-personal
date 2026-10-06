/**
 * Chat-path helpers for the sign-in alert hook (apps/web/lib/server/agent-run.ts): recover the
 * `EmailAnalysis` the model saw from this turn's `analyze_email` tool result, and rewrite the turn's
 * verdict block when a deterministic rule changed the verdict. Content of messages is attacker-controlled
 * and only ever parsed here, never logged.
 */
import type { MessageParam } from "@neo/core";
import type { EmailAnalysis } from "@neo/tools";
import type { Verdict } from "@neo/verdict";
import { replaceLastVerdict } from "@/lib/verdict-fence";
import { VERDICT_EMAIL_LABELS } from "../email/verdict-email";

type ContentBlockParam = Exclude<MessageParam["content"], string>[number];

function resultText(block: Extract<ContentBlockParam, { type: "tool_result" }>): string | undefined {
  if (typeof block.content === "string") return block.content;
  if (Array.isArray(block.content)) return block.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
  return undefined;
}

function isEmailAnalysis(v: unknown): v is EmailAnalysis {
  return !!v && typeof v === "object" && "input_kind" in v && "authentication" in v && "sender" in v && "content" in v && "urls" in v;
}

/**
 * Every `analyze_email` result in `messages`, in order, parsed out of its trust-boundary envelope. Results that
 * were truncated (the envelope then holds a string, not the analysis object) are skipped.
 */
export function findEmailAnalyses(messages: readonly MessageParam[]): EmailAnalysis[] {
  const names = new Map<string, string>();
  const found: EmailAnalysis[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type === "tool_use") names.set(b.id, b.name);
      if (b.type !== "tool_result" || b.is_error || names.get(b.tool_use_id) !== "analyze_email") continue;
      const text = resultText(b);
      if (!text) continue;
      try {
        const env = JSON.parse(text) as { data?: unknown };
        if (isEmailAnalysis(env.data)) found.push(env.data);
      } catch {
        /* not JSON: ignore */
      }
    }
  }
  return found;
}

/** The last `analyze_email` result in `messages` (see `findEmailAnalyses`). */
export function findEmailAnalysis(messages: readonly MessageParam[]): EmailAnalysis | undefined {
  return findEmailAnalyses(messages).at(-1);
}

const MIN_TOKEN = 6;

/** Distinctive strings of an analysis (subject, sender, link hosts) that a verdict about it would quote. */
function analysisTokens(a: EmailAnalysis): string[] {
  const out: string[] = [];
  const add = (v: string | undefined) => {
    const t = v?.trim().toLowerCase();
    if (t && t.length >= MIN_TOKEN) out.push(t);
  };
  add(a.content.subject);
  add(a.sender.from.address);
  add(a.sender.from.domain);
  for (const u of a.urls) {
    try {
      add(new URL(u.url).hostname);
    } catch {
      /* skip */
    }
  }
  return out;
}

/** True when the verdict's own text quotes something distinctive from the analysis. */
function refersTo(verdict: Verdict, a: EmailAnalysis): boolean {
  const blob = [
    verdict.headline,
    ...verdict.indicators.flatMap((i) => [i.evidence, i.explanation]),
    ...verdict.iocs.urls,
    ...verdict.iocs.domains,
  ]
    .join("\n")
    .toLowerCase();
  return analysisTokens(a).some((t) => blob.includes(t));
}

export type SigninAnalysisChoice =
  | { kind: "none" }
  | { kind: "analysis"; analysis: EmailAnalysis }
  /** More than one candidate and the verdict does not single one out: never upgrade, drop `signin_check`. */
  | { kind: "ambiguous" };

/**
 * Pick the analysis a chat verdict is about when the turn analyzed several emails. One analysis: that one.
 * Several: the one whose subject, sender or link hosts the verdict quotes, if exactly one does; otherwise, when
 * any analysis is a sign-in alert, the choice is ambiguous.
 */
export function selectSigninAnalysis(analyses: readonly EmailAnalysis[], verdict: Verdict): SigninAnalysisChoice {
  if (!analyses.some((a) => a.signin_alert)) return { kind: "none" };
  if (analyses.length === 1) return { kind: "analysis", analysis: analyses[0]! };
  const referenced = analyses.filter((a) => refersTo(verdict, a));
  if (referenced.length === 1) return referenced[0]!.signin_alert ? { kind: "analysis", analysis: referenced[0]! } : { kind: "none" };
  return { kind: "ambiguous" };
}

/** One line shown with the verdict when a deterministic rule overrode the model. */
export function signinOverrideNote(verdict: Verdict): string {
  return `A deterministic sign-in alert rule decided this verdict (${VERDICT_EMAIL_LABELS[verdict.verdict]}), not the model.`;
}

/**
 * Replace the last valid verdict block in the final assistant message with `verdict` and append `note` (when given) as a last line.
 * Returns the messages unchanged when no verdict block is found.
 */
export function rewriteFinalVerdict(messages: readonly MessageParam[], verdict: Verdict, note?: string): MessageParam[] {
  const out = [...messages];
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]!;
    if (m.role !== "assistant") continue;
    // The same fence scan as extractVerdict and the chat card: the stored text and the verdict row cannot disagree.
    const swap = (text: string): string | undefined => replaceLastVerdict(text, stripCheck(verdict), note);
    if (typeof m.content === "string") {
      const t = swap(m.content);
      if (t !== undefined) out[i] = { ...m, content: t };
      return out;
    }
    const blocks = [...m.content];
    for (let j = blocks.length - 1; j >= 0; j--) {
      const b = blocks[j]!;
      if (b.type !== "text") continue;
      const t = swap(b.text);
      if (t !== undefined) {
        blocks[j] = { ...b, text: t };
        out[i] = { ...m, content: blocks };
        return out;
      }
    }
    return out;
  }
  return out;
}

export function stripCheck(v: Verdict): Verdict {
  const { signin_check: _drop, ...rest } = v;
  return rest;
}
