import { ArtifactDecryptError } from "@neo/core";
import { describe, expect, it } from "vitest";
import {
  decryptMonitoredAddress,
  deriveGlobalBreachQueryDigest,
  deriveMonitoredAddressDigest,
  encryptMonitoredAddress,
  hashVerificationToken,
  issueVerificationToken,
  normalizeBreachAddress,
} from "@/lib/server/breach-monitoring/crypto";

const master = Buffer.from(new Uint8Array(32).fill(41)).toString("base64");
const source = { NEO_MASTER_KEY: master };
const identity = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  userId: "user-a",
  addressId: "22222222-2222-4222-8222-222222222222",
};

const aad = (i: typeof identity) => `neo:breach-address:v1:${i.tenantId}:${i.userId}:${i.addressId}`;

describe("breach monitoring cryptography", () => {
  it("normalizes an address consistently and rejects malformed input", () => {
    expect(normalizeBreachAddress("  Alice+tag@Example.COM ")).toBe("alice+tag@example.com");
    expect(() => normalizeBreachAddress("not-an-email")).toThrow();
  });

  it("derives tenant-scoped HMAC digests and separates the global coordination digest", async () => {
    const a = await deriveMonitoredAddressDigest(identity.tenantId, " Alice@Example.com ", source);
    const same = await deriveMonitoredAddressDigest(identity.tenantId, "alice@example.com", source);
    const otherTenant = await deriveMonitoredAddressDigest("33333333-3333-4333-8333-333333333333", "alice@example.com", source);
    const global = await deriveGlobalBreachQueryDigest("alice@example.com", source);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(same).toBe(a);
    expect(otherTenant).not.toBe(a);
    expect(global).not.toBe(a);
  });

  it("encrypts the address under the purpose-specific tenant key and binds tenant/user/address AAD", () => {
    const encrypted = encryptMonitoredAddress("alice@example.com", identity, source);
    expect(Buffer.from(encrypted).toString("utf8")).not.toContain("alice@example.com");
    expect(decryptMonitoredAddress(encrypted, identity, source)).toBe("alice@example.com");
    expect(() => decryptMonitoredAddress(encrypted, { ...identity, userId: "user-b" }, source)).toThrow(ArtifactDecryptError);
    expect(() => decryptMonitoredAddress(encrypted, { ...identity, tenantId: "33333333-3333-4333-8333-333333333333" }, source)).toThrow(ArtifactDecryptError);
    expect(() => decryptMonitoredAddress(encrypted, { ...identity, addressId: "44444444-4444-4444-8444-444444444444" }, source)).toThrow(ArtifactDecryptError);
    expect(aad(identity)).toContain(identity.addressId);
  });

  it("fails closed without a valid master key", async () => {
    await expect(deriveMonitoredAddressDigest(identity.tenantId, "alice@example.com", { VERCEL_ENV: "production" })).rejects.toThrow(/NEO_MASTER_KEY/);
    expect(() => encryptMonitoredAddress("alice@example.com", identity, { NEO_MASTER_KEY: "bad", VERCEL_ENV: "production" })).toThrow(/NEO_MASTER_KEY/);
  });

  it("issues random 256-bit verification tokens and stores only their SHA-256 digest", () => {
    const first = issueVerificationToken();
    const second = issueVerificationToken();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(second);
    expect(hashVerificationToken(first)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashVerificationToken(first)).not.toBe(first);
    expect(() => hashVerificationToken("short")).toThrow();
  });

  it("uses a deterministic dev key without NEO_MASTER_KEY outside a deployment", async () => {
    const encrypted = encryptMonitoredAddress("dev@example.com", identity, {});
    expect(decryptMonitoredAddress(encrypted, identity, {})).toBe("dev@example.com");
    expect(await deriveGlobalBreachQueryDigest("dev@example.com", {})).toBe(await deriveGlobalBreachQueryDigest("dev@example.com", {}));
    expect(() => decryptMonitoredAddress(encrypted, identity, source)).toThrow();
  });

  it.each([{ VERCEL_ENV: "production" }, { VERCEL_ENV: "preview" }, { NODE_ENV: "production" }])("fails closed without NEO_MASTER_KEY when deployed (%o)", async (deployed) => {
    expect(() => encryptMonitoredAddress("dev@example.com", identity, deployed)).toThrow(/NEO_MASTER_KEY/);
    await expect(deriveGlobalBreachQueryDigest("dev@example.com", deployed)).rejects.toThrow(/NEO_MASTER_KEY/);
    await expect(deriveMonitoredAddressDigest(identity.tenantId, "dev@example.com", deployed)).rejects.toThrow(/NEO_MASTER_KEY/);
  });
});
