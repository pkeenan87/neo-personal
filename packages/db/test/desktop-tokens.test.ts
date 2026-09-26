import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DESKTOP_TOKEN_PREFIX,
  hashDesktopToken,
  isDesktopTokenFormat,
  normalizeDesktopTokenName,
} from "../src/desktop-tokens.js";

describe("desktop tokens", () => {
  it("accepts minted neo_dt_ tokens and rejects junk", () => {
    const token = `${DESKTOP_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    expect(isDesktopTokenFormat(token)).toBe(true);
    expect(isDesktopTokenFormat("neo_dt_short")).toBe(false);
    expect(isDesktopTokenFormat("Bearer stuff")).toBe(false);
  });

  it("hashes stably", () => {
    const token = `${DESKTOP_TOKEN_PREFIX}${"a".repeat(43)}`;
    expect(hashDesktopToken(token)).toBe(createHash("sha256").update(token, "utf8").digest("hex"));
    expect(hashDesktopToken(token)).toBe(hashDesktopToken(token));
  });

  it("normalizes names", () => {
    expect(normalizeDesktopTokenName("  Omarchy   bar ")).toBe("Omarchy bar");
    expect(normalizeDesktopTokenName("")).toBeNull();
    expect(normalizeDesktopTokenName("x".repeat(65))).toBeNull();
  });
});
