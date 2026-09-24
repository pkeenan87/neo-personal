import { CHARS_PER_TOKEN } from "./config.js";

// How far back from the cap we look for a clean boundary.
const BOUNDARY_LOOKBACK_CHARS = 2_000;

/**
 * Find a clean truncation point at-or-before `charCap` for JSON / CSV /
 * line-structured content. Cutting mid-key produces output the model reads
 * as "the tool returned malformed data"; cutting one entry earlier at a
 * boundary is strictly better. Falls back to the hard cap.
 */
export function findCleanTruncationPoint(content: string, charCap: number): number {
  const minSearch = Math.max(0, charCap - BOUNDARY_LOOKBACK_CHARS);
  for (let i = charCap - 1; i >= minSearch; i--) {
    const ch = content[i];
    if (ch === "}" || ch === "]") return i + 1;
  }
  for (let i = charCap - 1; i >= minSearch; i--) {
    if (content[i] === "," && /\s/.test(content[i + 1] ?? "")) return i + 1;
  }
  for (let i = charCap - 1; i >= minSearch; i--) {
    if (content[i] === "\n") return i + 1;
  }
  return charCap;
}

/**
 * Truncate `content` to roughly `capTokens` tokens at a clean boundary and
 * append a notice. Returns the input unchanged when it already fits.
 */
export function truncateToolResult(content: string, capTokens: number): string {
  const charCap = Math.floor(capTokens * CHARS_PER_TOKEN);
  if (content.length <= charCap) return content;
  const cutPoint = findCleanTruncationPoint(content, charCap);
  return (
    content.slice(0, cutPoint) +
    `\n\n[Result truncated from ${content.length} to ${cutPoint} characters to fit the context budget. ` +
    `If you need details that are not shown, say so or re-run the tool with a narrower request.]`
  );
}
