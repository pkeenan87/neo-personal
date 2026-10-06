import { describe, expect, it } from "vitest";
import { breachMonitoringEnv } from "@/lib/env";

describe("breach-monitoring environment", () => {
  it("defaults to ten requests per minute and a descriptive user agent", () => {
    const config = breachMonitoringEnv({});
    expect(config).toMatchObject({ HIBP_RPM: 10 });
    expect(config.HIBP_API_KEY).toBeUndefined();
    expect(config.HIBP_USER_AGENT).toMatch(/Neo breach monitoring/);
  });

  it("trims the subscription key and user agent and accepts a bounded positive RPM", () => {
    expect(breachMonitoringEnv({ HIBP_API_KEY: " key ", HIBP_RPM: "73", HIBP_USER_AGENT: " Neo service/1 " })).toEqual({ HIBP_API_KEY: "key", HIBP_RPM: 73, HIBP_USER_AGENT: "Neo service/1" });
  });

  it.each(["0", "-2", "1.5", "not-a-number", "1001"])("uses the safe default for invalid RPM %s", (value) => {
    expect(breachMonitoringEnv({ HIBP_RPM: value }).HIBP_RPM).toBe(10);
  });
});
