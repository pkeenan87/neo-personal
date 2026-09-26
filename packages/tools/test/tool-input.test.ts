/**
 * Tool input schemas must accept the shapes gateway-translated strict tool
 * calling produces: every property present, unused ones blank. Found by the
 * Phase 2 injection eval (GPT-6 through AI Gateway sent `raw: ""` and
 * `pasted: { from: "", subject: "", body: "" }` next to `artifact_ref`).
 */
import { describe, expect, it } from "vitest";
import { AnalyzeEmailInputSchema } from "../src/email/tool.js";
import { AnalyzeSmsInputSchema } from "../src/sms/tool.js";

describe("AnalyzeEmailInputSchema", () => {
  it("treats blank siblings as absent", () => {
    const parsed = AnalyzeEmailInputSchema.parse({
      artifact_ref: "a0d63e73-1e26-424b-8d39-2af39185965d",
      raw: "",
      pasted: { from: "", subject: "", body: "" },
    });
    expect(parsed).toEqual({ artifact_ref: "a0d63e73-1e26-424b-8d39-2af39185965d", raw: undefined, pasted: undefined });
  });

  it("accepts null for the unused fields", () => {
    expect(AnalyzeEmailInputSchema.parse({ artifact_ref: null, raw: "From: a@b.example\n\nhi", pasted: null }).raw).toContain("From:");
  });

  it("drops blank from/subject inside pasted but keeps the body", () => {
    const parsed = AnalyzeEmailInputSchema.parse({ pasted: { from: " ", subject: "", body: "Your account is limited" } });
    expect(parsed.pasted).toEqual({ from: undefined, subject: undefined, body: "Your account is limited" });
  });

  it("still requires exactly one source", () => {
    expect(() => AnalyzeEmailInputSchema.parse({ artifact_ref: "", raw: "", pasted: { body: "" } })).toThrow(/exactly one/);
    expect(() => AnalyzeEmailInputSchema.parse({ artifact_ref: "x", raw: "y" })).toThrow(/exactly one/);
  });
});

describe("AnalyzeSmsInputSchema", () => {
  it("treats blank optional fields as absent", () => {
    const parsed = AnalyzeSmsInputSchema.parse({ sender: "", body: "Your package is waiting", received_at: "", user_country: "" });
    expect(parsed).toEqual({ sender: undefined, body: "Your package is waiting", received_at: undefined, user_country: undefined });
  });

  it("still validates a non-blank country code", () => {
    expect(AnalyzeSmsInputSchema.parse({ body: "hi", user_country: "us" }).user_country).toBe("US");
    expect(() => AnalyzeSmsInputSchema.parse({ body: "hi", user_country: "usa" })).toThrow();
  });
});
