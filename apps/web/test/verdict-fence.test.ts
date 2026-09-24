import { describe, expect, it } from "vitest";
import { hasVerdictFence, splitVerdictSegments, verdictToText } from "@/lib/verdict-fence";
import { isVerdict } from "@/types/verdict";
import { VERDICT_FIXTURE } from "./fixtures";

const json = JSON.stringify(VERDICT_FIXTURE, null, 2);

describe("```verdict fence detection", () => {
  it("splits text around a valid verdict block", () => {
    const content = `Here's what I found.\n\n\`\`\`verdict\n${json}\n\`\`\`\n\nStay safe.`;
    const segs = splitVerdictSegments(content);
    expect(segs.map((s) => s.kind)).toEqual(["markdown", "verdict", "markdown"]);
    expect(segs[1]).toMatchObject({ kind: "verdict", verdict: VERDICT_FIXTURE });
    expect(segs[0]).toMatchObject({ text: expect.stringContaining("Here's what I found.") });
    expect(hasVerdictFence(content)).toBe(true);
  });

  it("accepts case-insensitive info strings, longer fences, and up to 3 spaces of indent", () => {
    const content = `   \`\`\`\`Verdict\n${json}\n\`\`\`\`\nafter`;
    expect(splitVerdictSegments(content).map((s) => s.kind)).toEqual(["verdict", "markdown"]);
  });

  it("handles multiple verdict blocks", () => {
    const block = `\`\`\`verdict\n${JSON.stringify(VERDICT_FIXTURE)}\n\`\`\``;
    const segs = splitVerdictSegments(`${block}\n\nand\n\n${block}`);
    expect(segs.filter((s) => s.kind === "verdict")).toHaveLength(2);
  });

  it("ignores other code blocks and ```verdict text nested inside them", () => {
    const content = "```json\n{\"a\":1}\n```\n\n````md\n```verdict\n{}\n```\n````";
    const segs = splitVerdictSegments(content);
    expect(segs).toHaveLength(1);
    expect(segs[0]?.kind).toBe("markdown");
    expect(hasVerdictFence(content)).toBe(false);
  });

  it("does not match fences with extra info-string words", () => {
    expect(hasVerdictFence("```verdict extra\n{}\n```")).toBe(false);
    expect(hasVerdictFence("```verdicts\n{}\n```")).toBe(false);
  });

  it("flags invalid JSON and schema mismatches", () => {
    expect(splitVerdictSegments("```verdict\n{not json\n```")[0]).toMatchObject({ kind: "verdict_invalid", reason: "json" });
    const bad = { ...VERDICT_FIXTURE, verdict: "totally_fine" };
    expect(splitVerdictSegments(`\`\`\`verdict\n${JSON.stringify(bad)}\n\`\`\``)[0]).toMatchObject({
      kind: "verdict_invalid",
      reason: "schema",
    });
  });

  it("reports an unterminated block as pending while streaming, invalid after", () => {
    const partial = `Checking…\n\n\`\`\`verdict\n{"subject_type": "url",`;
    expect(splitVerdictSegments(partial, { streaming: true }).map((s) => s.kind)).toEqual(["markdown", "verdict_pending"]);
    expect(splitVerdictSegments(partial).at(-1)).toMatchObject({ kind: "verdict_invalid", reason: "unterminated" });
  });

  it("validates the Verdict mirror", () => {
    expect(isVerdict(VERDICT_FIXTURE)).toBe(true);
    expect(isVerdict({ ...VERDICT_FIXTURE, confidence: 1.5 })).toBe(false);
    expect(isVerdict({ ...VERDICT_FIXTURE, iocs: { ...VERDICT_FIXTURE.iocs, ips: [1] } })).toBe(false);
    expect(isVerdict({ ...VERDICT_FIXTURE, indicators: [{ severity: "extreme" }] })).toBe(false);
  });

  it("renders a plain-text report", () => {
    const text = verdictToText(VERDICT_FIXTURE);
    expect(text).toContain("Neo verdict: Suspicious (72% confidence)");
    expect(text).toContain("[high] Shortened link");
    expect(text).toContain("ips: 203.0.113.7");
  });
});
