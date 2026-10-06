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
 * The agent is told to emit exactly one such block per analysis (see
 * lib/server/system-prompt.ts); blocks are validated with VerdictSchema from
 * @neo/verdict, here for rendering and server-side before a verdict row is stored.
 */
import { VerdictSchema, type Verdict } from "@neo/verdict";

/** True when `v` is a valid Verdict (VerdictSchema from @neo/verdict). */
export function isVerdict(v: unknown): v is Verdict {
  return VerdictSchema.safeParse(v).success;
}

export type ContentSegment =
  | { kind: "markdown"; text: string }
  | { kind: "verdict"; verdict: Verdict; raw: string }
  | { kind: "verdict_invalid"; raw: string; reason: "json" | "schema" | "unterminated" }
  | { kind: "verdict_pending"; raw: string };

const VERDICT_OPEN = /^ {0,3}(`{3,})[ \t]*verdict[ \t]*$/i;
const ANY_OPEN = /^ {0,3}(`{3,}|~{3,})/;

/** Matcher for the line that closes a fence opened with `fence` (built once per fence, not per line). */
function closer(fence: string): (line: string) => boolean {
  const ch = fence[0] === "~" ? "~" : "`";
  const re = new RegExp(`^ {0,3}\\${ch}{${fence.length},}[ \\t]*$`);
  return (line) => re.test(line);
}

/** True when `content` contains at least one ```verdict opening fence outside other code blocks. */
export function hasVerdictFence(content: string): boolean {
  return splitVerdictSegments(content).some((s) => s.kind !== "markdown");
}

/** Line-level view of the content: runs of ordinary lines, and ```verdict blocks (close is undefined when unterminated). */
type Block = { kind: "lines"; lines: string[] } | { kind: "verdict"; open: string; body: string[]; close?: string };

/** One linear pass; the single place that decides what is a verdict fence (code blocks other than ```verdict are copied through). */
function scanBlocks(content: string): Block[] {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let md: string[] = [];
  let i = 0;
  const flush = () => {
    if (md.length) out.push({ kind: "lines", lines: md });
    md = [];
  };

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const vOpen = VERDICT_OPEN.exec(line);
    if (vOpen) {
      const isClose = closer(vOpen[1] ?? "```");
      const body: string[] = [];
      let j = i + 1;
      let close: string | undefined;
      while (j < lines.length) {
        const l = lines[j] ?? "";
        if (isClose(l)) {
          close = l;
          break;
        }
        body.push(l);
        j++;
      }
      flush();
      out.push({ kind: "verdict", open: line, body, ...(close !== undefined ? { close } : {}) });
      if (close === undefined) break;
      i = j + 1;
      continue;
    }

    const anyOpen = ANY_OPEN.exec(line);
    if (anyOpen) {
      // Ordinary fenced code block: copy through verbatim, including any
      // ```verdict text inside it.
      const isClose = closer(anyOpen[1] ?? "```");
      md.push(line);
      i++;
      while (i < lines.length) {
        const l = lines[i] ?? "";
        md.push(l);
        i++;
        if (isClose(l)) break;
      }
      continue;
    }

    md.push(line);
    i++;
  }
  flush();
  return out;
}

function parseVerdict(raw: string): { ok: true; verdict: Verdict } | { ok: false; reason: "json" | "schema" } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "json" };
  }
  return isVerdict(parsed) ? { ok: true, verdict: parsed } : { ok: false, reason: "schema" };
}

/**
 * Split assistant content into Markdown and verdict segments.
 * @param streaming when true, an unterminated verdict block yields `verdict_pending`.
 */
export function splitVerdictSegments(content: string, opts: { streaming?: boolean } = {}): ContentSegment[] {
  const out: ContentSegment[] = [];
  for (const b of scanBlocks(content)) {
    if (b.kind === "lines") {
      const text = b.lines.join("\n");
      if (text.trim()) out.push({ kind: "markdown", text });
      continue;
    }
    const raw = b.body.join("\n");
    if (b.close === undefined) {
      out.push(opts.streaming ? { kind: "verdict_pending", raw } : { kind: "verdict_invalid", raw, reason: "unterminated" });
      continue;
    }
    const r = parseVerdict(raw);
    out.push(r.ok ? { kind: "verdict", verdict: r.verdict, raw } : { kind: "verdict_invalid", raw, reason: r.reason });
  }
  return out;
}

/**
 * Replace the body of the LAST valid ```verdict block in `content` with `verdict` (everything else is kept
 * byte for byte, apart from CRLF becoming LF), and append `note` as a last paragraph when given. Uses the same
 * scan as `splitVerdictSegments`, so it targets exactly the block `extractVerdict` and the chat card read.
 * Undefined when there is no valid verdict block.
 */
export function replaceLastVerdict(content: string, verdict: Verdict, note?: string): string | undefined {
  const blocks = scanBlocks(content);
  let target = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (b.kind === "verdict" && b.close !== undefined && parseVerdict(b.body.join("\n")).ok) {
      target = i;
      break;
    }
  }
  if (target < 0) return undefined;
  const lines: string[] = [];
  blocks.forEach((b, i) => {
    if (b.kind === "lines") lines.push(...b.lines);
    else if (i === target) lines.push(b.open, ...JSON.stringify(verdict, null, 2).split("\n"), b.close!);
    else lines.push(b.open, ...b.body, ...(b.close !== undefined ? [b.close] : []));
  });
  const text = lines.join("\n");
  return note ? `${text.replace(/\s+$/, "")}\n\n${note}` : text;
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
