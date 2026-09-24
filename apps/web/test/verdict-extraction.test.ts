// @vitest-environment node
import type { MessageParam } from "@neo/core";
import { analyzeUrl, MOCK_URLS, URL_ANALYSIS_GUIDANCE } from "@neo/tools";
import { VerdictSchema } from "@neo/verdict";
import { describe, expect, it } from "vitest";
import { mockVerdictFor } from "@/lib/server/mock-model";
import { NEO_SYSTEM_PROMPT } from "@/lib/server/system-prompt";
import { extractVerdict, finalAssistantText } from "@/lib/server/verdicts";
import { VERDICT_FIXTURE } from "./fixtures";

const block = (v: unknown) => "```verdict\n" + JSON.stringify(v) + "\n```";

describe("extractVerdict", () => {
  it("parses the ```verdict block of the final assistant message", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "is this safe?" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Here's what I found.\n\n" },
          { type: "text", text: `${block(VERDICT_FIXTURE)}\n\nStay safe.` },
        ],
      },
    ];
    expect(extractVerdict(messages)).toEqual(VERDICT_FIXTURE);
  });

  it("uses the last valid block and ignores invalid ones", () => {
    const second = { ...VERDICT_FIXTURE, verdict: "malicious" as const };
    const text = `${block(VERDICT_FIXTURE)}\n\n${block(second)}\n\n${block({ ...VERDICT_FIXTURE, confidence: 2 })}`;
    expect(extractVerdict([{ role: "assistant", content: text }])).toEqual(second);
  });

  it("returns null without a valid block, and ignores earlier assistant messages", () => {
    expect(extractVerdict([{ role: "assistant", content: "No verdict here." }])).toBeNull();
    expect(extractVerdict([{ role: "assistant", content: block({ verdict: "malicious" }) }])).toBeNull();
    expect(
      extractVerdict([
        { role: "assistant", content: block(VERDICT_FIXTURE) },
        { role: "user", content: "thanks" },
        { role: "assistant", content: "You're welcome." },
      ]),
    ).toBeNull();
    expect(extractVerdict([])).toBeNull();
    expect(finalAssistantText([{ role: "user", content: "x" }])).toBe("");
  });
});

describe("MOCK_MODE scripted verdicts", () => {
  it.each(Object.entries(MOCK_URLS))("produce a schema-valid verdict for the %s fixture", async (_name, url) => {
    const analysis = await analyzeUrl(url, { deps: { mock: true } });
    const v = mockVerdictFor(analysis);
    expect(VerdictSchema.safeParse(v).success).toBe(true);
  });

  it("marks the phishing fixture malicious and the clean one likely_safe", async () => {
    expect(mockVerdictFor(await analyzeUrl(MOCK_URLS.phish, { deps: { mock: true } })).verdict).toBe("malicious");
    expect(mockVerdictFor(await analyzeUrl(MOCK_URLS.clean, { deps: { mock: true } })).verdict).toBe("likely_safe");
  });
});

describe("system prompt", () => {
  it("includes the URL guidance, the verdict convention and schema, and the trust-boundary rules", () => {
    expect(NEO_SYSTEM_PROMPT).toContain(URL_ANALYSIS_GUIDANCE);
    expect(NEO_SYSTEM_PROMPT).toContain("```verdict");
    expect(NEO_SYSTEM_PROMPT).toContain('"recommended_actions"');
    expect(NEO_SYSTEM_PROMPT).toContain("_neo_trust_boundary");
    expect(NEO_SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}T/); // nothing volatile: stays cacheable
  });
});
