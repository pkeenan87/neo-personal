import { afterEach, describe, expect, it, vi } from "vitest";
import { SAFE_METADATA_FIELDS, hashPii, logger } from "../src/logger.js";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.LOG_LEVEL;
});

function captureWarn(): () => Record<string, unknown> {
  const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
  return () => JSON.parse(String(spy.mock.calls.at(-1)![0])) as Record<string, unknown>;
}

describe("hashPii", () => {
  it("is a stable 16-hex-char one-way hash", () => {
    expect(hashPii("alice@example.com")).toMatch(/^[0-9a-f]{16}$/);
    expect(hashPii("alice@example.com")).toBe(hashPii("alice@example.com"));
    expect(hashPii("alice@example.com")).not.toBe(hashPii("bob@example.com"));
  });
});

describe("logger metadata allowlist", () => {
  it("keeps allowlisted fields and drops everything else", () => {
    const last = captureWarn();
    logger.warn("tool ran", "agent", {
      toolName: "check_url",
      conversationId: "c1",
      cacheHitRate: 0.5,
      email: "alice@example.com",
      body: "Dear customer, your account...",
      userId: "raw-user-id",
    });
    const entry = last();
    expect(entry.meta).toEqual({ toolName: "check_url", conversationId: "c1", cacheHitRate: 0.5 });
    expect(JSON.stringify(entry)).not.toContain("alice@example.com");
    expect(JSON.stringify(entry)).not.toContain("raw-user-id");
  });

  it("omits meta entirely when nothing survives the allowlist", () => {
    const last = captureWarn();
    logger.warn("m", "c", { secret: "x" });
    expect(last()).not.toHaveProperty("meta");
  });

  it("never allowlists raw identity or content fields", () => {
    for (const key of ["userId", "email", "body", "content", "input", "result", "text", "apiKey"]) {
      expect(SAFE_METADATA_FIELDS.has(key)).toBe(false);
    }
  });
});

describe("logger output", () => {
  it("writes one JSON line per entry, so embedded newlines cannot forge entries", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logger.error("bad\n{\"level\":\"info\",\"msg\":\"forged\"}", "agent");
    const line = String(spy.mock.calls[0]![0]);
    expect(line.split("\n")).toHaveLength(1);
    expect(JSON.parse(line)).toMatchObject({ level: "error", component: "agent" });
  });

  it("respects LOG_LEVEL", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    process.env.LOG_LEVEL = "error";
    logger.info("hidden", "c");
    expect(log).not.toHaveBeenCalled();
    process.env.LOG_LEVEL = "debug";
    logger.debug("shown", "c");
    expect(log).toHaveBeenCalledOnce();
  });
});
