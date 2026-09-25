import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ARTIFACT_CIPHERTEXT_OVERHEAD,
  ArtifactDecryptError,
  decryptArtifact,
  deriveTenantKey,
  encryptArtifact,
  masterKeyFromEnv,
} from "../src/artifact-crypto.js";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const ARTIFACT = "33333333-3333-4333-8333-333333333333";

const master = () => new Uint8Array(randomBytes(32));
const utf8 = (s: string) => new TextEncoder().encode(s);

describe("masterKeyFromEnv", () => {
  it("returns undefined when unset or blank", () => {
    expect(masterKeyFromEnv({})).toBeUndefined();
    expect(masterKeyFromEnv({ NEO_MASTER_KEY: "  " })).toBeUndefined();
  });

  it("decodes 32 bytes of standard or url-safe base64", () => {
    const key = randomBytes(32);
    expect(Buffer.from(masterKeyFromEnv({ NEO_MASTER_KEY: key.toString("base64") })!)).toEqual(key);
    expect(Buffer.from(masterKeyFromEnv({ NEO_MASTER_KEY: key.toString("base64url") })!)).toEqual(key);
  });

  it("rejects the wrong length or non-base64", () => {
    expect(() => masterKeyFromEnv({ NEO_MASTER_KEY: randomBytes(16).toString("base64") })).toThrow(/32 bytes/);
    expect(() => masterKeyFromEnv({ NEO_MASTER_KEY: "not base64 at all!" })).toThrow(/base64/);
  });
});

describe("deriveTenantKey", () => {
  it("is deterministic per tenant and differs across tenants and master keys", () => {
    const m = master();
    const a1 = deriveTenantKey(m, TENANT_A);
    expect(a1).toHaveLength(32);
    expect(Buffer.from(deriveTenantKey(m, TENANT_A))).toEqual(Buffer.from(a1));
    expect(Buffer.from(deriveTenantKey(m, TENANT_B))).not.toEqual(Buffer.from(a1));
    expect(Buffer.from(deriveTenantKey(master(), TENANT_A))).not.toEqual(Buffer.from(a1));
  });

  it("rejects a short master key or empty tenant", () => {
    expect(() => deriveTenantKey(new Uint8Array(16), TENANT_A)).toThrow();
    expect(() => deriveTenantKey(master(), "")).toThrow();
  });
});

describe("encryptArtifact / decryptArtifact", () => {
  const m = master();
  const key = deriveTenantKey(m, TENANT_A);
  const plaintext = utf8("From: attacker@example.test\r\nSubject: Verify your account\r\n\r\nClick here");

  it("round-trips with the NEO1 layout and a fresh IV each time", () => {
    const blob = encryptArtifact(key, plaintext, ARTIFACT);
    expect(Buffer.from(blob.subarray(0, 4)).toString("ascii")).toBe("NEO1");
    expect(blob.length).toBe(plaintext.length + ARTIFACT_CIPHERTEXT_OVERHEAD);
    expect(Buffer.from(blob).includes(Buffer.from("Verify your account"))).toBe(false);
    expect(Buffer.from(decryptArtifact(key, blob, ARTIFACT))).toEqual(Buffer.from(plaintext));
    const again = encryptArtifact(key, plaintext, ARTIFACT);
    expect(Buffer.from(again)).not.toEqual(Buffer.from(blob));
  });

  it("handles empty plaintext", () => {
    const blob = encryptArtifact(key, new Uint8Array(0), ARTIFACT);
    expect(decryptArtifact(key, blob, ARTIFACT)).toHaveLength(0);
  });

  it("fails with another tenant's key", () => {
    const blob = encryptArtifact(key, plaintext, ARTIFACT);
    expect(() => decryptArtifact(deriveTenantKey(m, TENANT_B), blob, ARTIFACT)).toThrow(ArtifactDecryptError);
  });

  it("fails with another artifact id as AAD", () => {
    const blob = encryptArtifact(key, plaintext, ARTIFACT);
    expect(() => decryptArtifact(key, blob, "44444444-4444-4444-8444-444444444444")).toThrow(ArtifactDecryptError);
  });

  it("fails on a tampered tag, body, or magic, and on truncation", () => {
    const blob = encryptArtifact(key, plaintext, ARTIFACT);
    const tag = Uint8Array.from(blob);
    tag[tag.length - 1] = tag[tag.length - 1]! ^ 0x01;
    expect(() => decryptArtifact(key, tag, ARTIFACT)).toThrow(ArtifactDecryptError);
    const body = Uint8Array.from(blob);
    body[20] = body[20]! ^ 0xff;
    expect(() => decryptArtifact(key, body, ARTIFACT)).toThrow(ArtifactDecryptError);
    const magic = Uint8Array.from(blob);
    magic[0] = 0x58;
    expect(() => decryptArtifact(key, magic, ARTIFACT)).toThrow(/unknown format/);
    expect(() => decryptArtifact(key, blob.subarray(0, 10), ARTIFACT)).toThrow(/truncated/);
  });
});
