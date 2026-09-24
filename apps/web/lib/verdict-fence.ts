/**
 * ```verdict fence convention
 * ───────────────────────────
 * An assistant message may embed one or more structured verdicts as a
 * fenced code block whose info string is exactly `verdict` and whose body
 * is a single JSON object matching `Verdict` (docs/contracts.md):
 *
 *     Here's what I found.
 *
 *     ```verdict
 *     { "subject_type": "url", "verdict": "malicious", "confidence": 0.93, ... }
 *     ```
 *
 * The chat UI renders each valid block as a <VerdictCard> in place and the
 * surrounding text as Markdown. Rules:
 *   - The opening fence is 3+ backticks followed by `verdict` (case-insensitive)
 *     and nothing else; it may be indented at most 3 spaces.
 *   - The block closes at the next line of >= as many backticks and nothing else.
 *   - Fences inside another fenced code block are ignored.
 *   - Invalid JSON / schema mismatch → rendered as a plain code block with a
 *     notice (never silently dropped).
 *   - An unterminated block while the message is still streaming renders a
 *     placeholder; once the stream ends it is treated as invalid.
 *
 * The integration pass makes the agent emit this block (system prompt +
 * structured output); `isVerdict` is swapped for VerdictSchema from @neo/verdict.
 */
import { isVerdict, type Verdict } from "@/types/verdict";

export type ContentSegment =
  | { kind: "markdown"; text: string }
  | { kind: "verdict"; verdict: Verdict; raw: string }
  | { kind: "verdict_invalid"; raw: string; reason: "json" | "schema" | "unterminated" }
  | { kind: "verdict_pending"; raw: string };

const VERDICT_OPEN = /^ {0,3}(`{3,})[ \t]*verdict[ \t]*$/i;
const ANY_OPEN = /^ {0,3}(`{3,}|~{3,})/;

function isClose(line: string, fence: string): boolean {
  const ch = fence[0] === "~" ? "~" : "`";
  const re = new RegExp(`^ {0,3}\\${ch}{${fence.length},}[ \\t]*$`);
  return re.test(line);
}

/** True when `content` contains at least one ```verdict opening fence outside other code blocks. */
export function hasVerdictFence(content: string): boolean {
  return splitVerdictSegments(content).some((s) => s.kind !== "markdown");
}

/**
 * Split assistant content into Markdown and verdict segments.
 * @param streaming when true, an unterminated verdict block yields `verdict_pending`.
 */
export function splitVerdictSegments(content: string, opts: { streaming?: boolean } = {}): ContentSegment[] {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const out: ContentSegment[] = [];
  let md: string[] = [];
  let i = 0;

  const flushMd = () => {
    const text = md.join("\n");
    if (text.trim()) out.push({ kind: "markdown", text });
    md = [];
  };

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const vOpen = VERDICT_OPEN.exec(line);
    if (vOpen) {
      const fence = vOpen[1] ?? "```";
      const body: string[] = [];
      let j = i + 1;
      let closed = false;
      while (j < lines.length) {
        const l = lines[j] ?? "";
        if (isClose(l, fence)) {
          closed = true;
          break;
        }
        body.push(l);
        j++;
      }
      flushMd();
      const raw = body.join("\n");
      if (!closed) {
        out.push(opts.streaming ? { kind: "verdict_pending", raw } : { kind: "verdict_invalid", raw, reason: "unterminated" });
        break;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        out.push({ kind: "verdict_invalid", raw, reason: "json" });
        i = j + 1;
        continue;
      }
      out.push(isVerdict(parsed) ? { kind: "verdict", verdict: parsed, raw } : { kind: "verdict_invalid", raw, reason: "schema" });
      i = j + 1;
      continue;
    }

    const anyOpen = ANY_OPEN.exec(line);
    if (anyOpen) {
      // Ordinary fenced code block: copy through verbatim, including any
      // ```verdict text inside it.
      const fence = anyOpen[1] ?? "```";
      md.push(line);
      i++;
      while (i < lines.length) {
        const l = lines[i] ?? "";
        md.push(l);
        i++;
        if (isClose(l, fence)) break;
      }
      continue;
    }

    md.push(line);
    i++;
  }
  flushMd();
  return out;
}

/** Plain-text report of a verdict, used by the "Copy report" button. */
export function verdictToText(v: Verdict): string {
  const pct = Math.round(v.confidence * 100);
  const label = VERDICT_LABELS[v.verdict];
  const lines: string[] = [`Neo verdict: ${label} (${pct}% confidence)`, v.headline, ""];
  if (v.indicators.length) {
    lines.push("Indicators:");
    for (const i of v.indicators) lines.push(`- [${i.severity}] ${i.category}: ${i.evidence} — ${i.explanation}`);
    lines.push("");
  }
  if (v.recommended_actions.length) {
    lines.push("Recommended actions:");
    for (const a of v.recommended_actions) {
      lines.push(`- (${a.urgency}) ${a.action}${a.deep_link ? ` <${a.deep_link}>` : ""}`);
    }
    lines.push("");
  }
  const iocs = Object.entries(v.iocs).filter(([, arr]) => arr.length > 0);
  if (iocs.length) {
    lines.push("Indicators of compromise:");
    for (const [k, arr] of iocs) lines.push(`- ${k}: ${arr.join(", ")}`);
  }
  return lines.join("\n").trim();
}

export const VERDICT_LABELS: Record<Verdict["verdict"], string> = {
  malicious: "Dangerous",
  suspicious: "Suspicious",
  likely_safe: "Likely safe",
  insufficient_evidence: "Not enough evidence",
};
