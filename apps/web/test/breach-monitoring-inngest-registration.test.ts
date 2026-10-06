import { describe, expect, it } from "vitest";
import { functions } from "@/inngest/functions";
import { breachCheck, breachMonitoringCron, breachVerificationCleanup } from "@/inngest/functions/breach-monitoring";

describe("breach monitoring Inngest registration", () => {
  it("serves the weekly dispatcher, HIBP worker, and daily token cleanup", () => {
    expect(functions).toContain(breachMonitoringCron);
    expect(functions).toContain(breachCheck);
    expect(functions).toContain(breachVerificationCleanup);
  });
});
