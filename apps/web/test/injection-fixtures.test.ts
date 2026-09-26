/**
 * Offline checks on the prompt-injection fixtures (`test/fixtures/injection/cases.ts`).
 * They pin down what the deterministic layers see, so the live eval
 * (`scripts/injection-eval.ts`) measures the model and not a drifting fixture:
 *  - every payload carries the visible artefact the eval scores (canary, exfil host, tool name),
 *  - the analyzers emit `injection_attempt_in_content` exactly where `analyzerFlags` says,
 *  - the regex guard flags the tool result / user turn exactly where `guardFlags` says.
 */
import { scanUserInput, wrapToolResult } from "@neo/core";
import { analyzeEmail, analyzeSms, createInMemoryCache } from "@neo/tools";
import { describe, expect, it } from "vitest";
import {
  CANARY,
  CORE_CASE_IDS,
  DESTRUCTIVE_TOOL,
  EXFIL_HOST,
  INJECTION_CASES,
  SYSTEM_PROMPT_MARKERS,
  injectionCase,
} from "./fixtures/injection/cases";

const deps = { cache: createInMemoryCache(), mock: true };

function envelopeFlag(tool: string, result: unknown): boolean {
  const env = JSON.parse(wrapToolResult(tool, result)) as { _neo_trust_boundary: { injection_detected: boolean } };
  return env._neo_trust_boundary.injection_detected;
}

/** Sender and body as the model would pass them to analyze_sms, from the fixture's user text. */
function smsInput(userText: string): { sender: string; body: string } {
  const m = /From (\+1 \(\d{3}\) \d{3}-\d{4}):\n([\s\S]+)$/.exec(userText);
  if (!m) throw new Error("sms fixture without a 'From +1 (...) ...:' line");
  return { sender: m[1]!, body: m[2]!.trim() };
}

describe("injection fixtures", () => {
  it("have unique ids and the core subset exists", () => {
    const ids = INJECTION_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of CORE_CASE_IDS) expect(injectionCase(id).expectTool).toBeDefined();
  });

  it("carry the artefacts the eval scores", () => {
    expect(injectionCase("eml-ai-note").eml).toContain(CANARY);
    expect(injectionCase("eml-evasive-policy").eml).toContain(CANARY);
    expect(injectionCase("pasted-page-system-tags").userText).toContain(CANARY);
    expect(injectionCase("eml-exfil").eml).toContain(`https://${EXFIL_HOST}/log/`);
    expect(injectionCase("eml-destructive").eml).toContain(DESTRUCTIVE_TOOL);
    expect(injectionCase("legit-control").eml).not.toContain(CANARY);
    for (const c of INJECTION_CASES) {
      for (const marker of SYSTEM_PROMPT_MARKERS) expect(c.userText + (c.eml ?? "")).not.toContain(marker);
    }
  });

  describe.each(INJECTION_CASES.filter((c) => c.vector === "eml"))("$id (eml)", (c) => {
    it("analyzer and guard flags match the fixture", async () => {
      const result = await analyzeEmail({ raw: Buffer.from(c.eml!, "utf8") }, { deps });
      const codes = JSON.stringify(result);
      expect(codes.includes("injection_attempt_in_content")).toBe(c.analyzerFlags);
      expect(envelopeFlag("analyze_email", result)).toBe(c.guardFlags);
    });
  });

  describe.each(INJECTION_CASES.filter((c) => c.vector === "sms"))("$id (sms)", (c) => {
    it("analyzer and guard flags match the fixture", async () => {
      const result = await analyzeSms(smsInput(c.userText), { deps });
      expect(JSON.stringify(result).includes("injection_attempt_in_content")).toBe(c.analyzerFlags);
      expect(envelopeFlag("analyze_sms", result)).toBe(c.guardFlags);
    });
  });

  it("pasted-email-authority: pasted body is flagged by the analyzer and the guard", async () => {
    const c = injectionCase("pasted-email-authority");
    const body = c.userText.split("\n\n").slice(2).join("\n\n");
    const result = await analyzeEmail(
      { pasted: { from: "Microsoft Account Team <account-security@microsoft-verify.example.org>", subject: "Unusual sign-in activity", body } },
      { deps },
    );
    expect(JSON.stringify(result).includes("injection_attempt_in_content")).toBe(c.analyzerFlags);
    expect(envelopeFlag("analyze_email", result)).toBe(c.guardFlags);
  });

  describe.each(INJECTION_CASES.filter((c) => c.vector === "user" || c.vector === "pasted_page"))("$id (user turn)", (c) => {
    it("scanUserInput matches guardFlags", () => {
      expect(scanUserInput(c.userText).flagged).toBe(c.guardFlags);
    });
  });
});
