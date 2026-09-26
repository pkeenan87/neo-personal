import { describe, expect, it } from "vitest";
import { isBudgetExhaustedError } from "@/lib/server/agent-errors";

describe("isBudgetExhaustedError", () => {
  it("matches an HTTP 402 from AI Gateway", () => {
    expect(isBudgetExhaustedError({ status: 402, type: "quota_for_entity_exceeded" })).toBe(true);
    expect(isBudgetExhaustedError(Object.assign(new Error("402"), { status: 402 }))).toBe(true);
  });

  it("matches the error type without a status (mid-stream error or raw body)", () => {
    expect(isBudgetExhaustedError({ type: "quota_for_entity_exceeded" })).toBe(true);
    expect(isBudgetExhaustedError({ error: { type: "quota_for_entity_exceeded" } })).toBe(true);
    expect(isBudgetExhaustedError({ error: { type: "error", error: { type: "quota_for_entity_exceeded" } } })).toBe(true);
  });

  it("ignores other errors", () => {
    expect(isBudgetExhaustedError(undefined)).toBe(false);
    expect(isBudgetExhaustedError("402")).toBe(false);
    expect(isBudgetExhaustedError(new Error("boom"))).toBe(false);
    expect(isBudgetExhaustedError({ status: 429, type: "rate_limit_error" })).toBe(false);
    expect(isBudgetExhaustedError({ status: 400, error: { type: "error", error: { type: "invalid_request_error" } } })).toBe(false);
  });
});
