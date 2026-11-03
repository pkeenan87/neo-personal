// @vitest-environment node
/**
 * Policy signing (_specs/v2-m2-child.md section 4): backend selection, the three signers, and the
 * normalization of a KMS signature (raw r || s or ASN.1 DER) to raw 64 bytes. No network: `@vercel/kms`
 * and the JWKS fetch are mocked.
 */
import { generateKeyPairSync, sign as nodeSign, verify as nodeVerify, type KeyObject } from "node:crypto";
import { base64urlEncode, canonicalJson, verifyPolicyEnvelope, type PolicyBundle } from "@neo/verdict";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPolicySigningService, normalizeEcdsaSignature, setPolicySigningServiceForTests } from "@/lib/server/policy-signer";

const kms = vi.hoisted(() => ({ signMessage: vi.fn() }));
vi.mock("@vercel/kms", () => kms);

const BODY = new TextEncoder().encode('{"hello":"world"}');

function pem(key: KeyObject): string {
  return key.export({ format: "pem", type: "pkcs8" }).toString();
}

function envelopeFor(bundle: PolicyBundle, sig: Uint8Array, keyId: string) {
  return { bundle, sig: base64urlEncode(sig), keyId, alg: "ES256" };
}

const BUNDLE: PolicyBundle = {
  v: 1,
  deviceId: "11111111-1111-4111-8111-111111111111",
  memberId: "22222222-2222-4222-8222-222222222222",
  policyVersion: "a".repeat(64),
  issuedAt: "2026-11-02T12:00:00.000Z",
  expiresAt: "2026-11-09T12:00:00.000Z",
  timeZone: "UTC",
  mode: "standard",
  web: { categories: [], safeSearch: false, youtubeRestricted: "off", allow: [], block: [] },
  apps: { block: [], requireApproval: false, approved: [] },
  screenTime: { dailyMinutes: { mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null }, downtime: [], warnMinutes: 0, allowDuringDowntime: [], grants: [] },
};

beforeEach(() => {
  setPolicySigningServiceForTests(undefined);
  kms.signMessage.mockReset();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubEnv("NEO_POLICY_KMS_ISSUER", "");
  vi.stubEnv("NEO_POLICY_SIGNING_KEY", "");
  vi.stubEnv("NEO_POLICY_KEY_ID", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setPolicySigningServiceForTests(undefined);
});

describe("normalizeEcdsaSignature", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });

  it("returns a 64-byte signature unchanged", () => {
    const raw = new Uint8Array(nodeSign("sha256", BODY, { key: privateKey, dsaEncoding: "ieee-p1363" }));
    expect(raw).toHaveLength(64);
    expect([...normalizeEcdsaSignature(raw)]).toEqual([...raw]);
  });

  it("converts DER to the same r || s that ieee-p1363 produces, over many signatures (leading zeros, 33-byte integers)", () => {
    for (let i = 0; i < 200; i++) {
      const msg = new TextEncoder().encode(`message ${i}`);
      const der = new Uint8Array(nodeSign("sha256", msg, { key: privateKey, dsaEncoding: "der" }));
      const raw = normalizeEcdsaSignature(der);
      expect(raw).toHaveLength(64);
      expect(nodeVerify("sha256", msg, { key: publicKey, dsaEncoding: "ieee-p1363" }, raw)).toBe(true);
      // Re-wrap the raw form as DER the way Node does and compare bytes: same integers, same encoding.
      expect(derOf(raw)).toEqual([...der]);
    }
  });

  it("handles DER integers shorter than 32 bytes by left-padding", () => {
    // r = 1, s = 2: SEQUENCE { INTEGER 01, INTEGER 02 }
    const raw = normalizeEcdsaSignature(new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02]));
    expect(raw).toHaveLength(64);
    expect(raw[31]).toBe(1);
    expect(raw[63]).toBe(2);
    expect(raw.slice(0, 31).every((b) => b === 0)).toBe(true);
  });

  it("rejects anything that is neither raw nor DER", () => {
    expect(() => normalizeEcdsaSignature(new Uint8Array(10))).toThrow(/unrecognized/);
    expect(() => normalizeEcdsaSignature(new Uint8Array(72).fill(7))).toThrow(/unrecognized/);
    expect(() => normalizeEcdsaSignature(new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01]))).toThrow();
    // An integer wider than 32 bytes (after stripping zeros) is not a P-256 value.
    const wide = new Uint8Array([0x30, 0x27, 0x02, 0x21, 0x01, ...new Uint8Array(32), 0x02, 0x01, 0x01]);
    expect(() => normalizeEcdsaSignature(wide)).toThrow();
  });
});

/** Minimal DER writer for the signature, to compare with Node's own. */
function derOf(raw: Uint8Array): number[] {
  const int = (b: Uint8Array): number[] => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const v = [...b.slice(i)];
    if (v[0]! & 0x80) v.unshift(0);
    return [0x02, v.length, ...v];
  };
  const body = [...int(raw.slice(0, 32)), ...int(raw.slice(32))];
  return [0x30, body.length, ...body];
}

describe("signer selection", () => {
  it("uses an ephemeral key in development, with a stable key id and a public JWK", async () => {
    const s = getPolicySigningService();
    expect(s?.kind).toBe("ephemeral");
    expect(getPolicySigningService()).toBe(s);
    const keys = await s!.publicKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ kid: expect.stringMatching(/^ephemeral-[0-9a-f]{16}$/), alg: "ES256", jwk: { kty: "EC", crv: "P-256" } });
    expect(await s!.currentKeyId()).toBe(keys[0]!.kid);
  });

  it("has no signer on a production or preview deployment without configuration", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    expect(getPolicySigningService()).toBeNull();
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(getPolicySigningService()).toBeNull();
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("NODE_ENV", "production");
    expect(getPolicySigningService()).toBeNull();
  });

  it("prefers KMS over the env key, and the env key over ephemeral", () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    vi.stubEnv("NEO_POLICY_SIGNING_KEY", pem(privateKey));
    expect(getPolicySigningService()?.kind).toBe("env");
    vi.stubEnv("NEO_POLICY_KMS_ISSUER", "issuer_abc");
    expect(getPolicySigningService()?.kind).toBe("kms");
  });

  it("refuses an unusable env key rather than falling back to a throwaway one", () => {
    vi.stubEnv("NEO_POLICY_SIGNING_KEY", "not a pem");
    expect(getPolicySigningService()).toBeNull();
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    vi.stubEnv("NEO_POLICY_SIGNING_KEY", pem(rsa));
    expect(getPolicySigningService()).toBeNull();
    const p384 = generateKeyPairSync("ec", { namedCurve: "P-384" }).privateKey;
    vi.stubEnv("NEO_POLICY_SIGNING_KEY", pem(p384));
    expect(getPolicySigningService()).toBeNull();
  });
});

describe("env and ephemeral signers", () => {
  it("signs raw r || s that verifies with the published key, using the fingerprint as key id", async () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    vi.stubEnv("NEO_POLICY_SIGNING_KEY", pem(privateKey));
    const s = getPolicySigningService()!;
    const signed = await s.sign(new TextEncoder().encode(canonicalJson(BUNDLE)));
    expect(signed.sig).toHaveLength(64);
    expect(signed.alg).toBe("ES256");
    expect(signed.keyId).toMatch(/^[0-9a-f]{16}$/);
    const keys = await s.publicKeys();
    expect(keys[0]!.kid).toBe(signed.keyId);
    expect((await verifyPolicyEnvelope(envelopeFor(BUNDLE, signed.sig, signed.keyId), [keys[0]!.jwk])).ok).toBe(true);
  });

  it("accepts a one-line PEM with literal \\n and a key id override", async () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    vi.stubEnv("NEO_POLICY_SIGNING_KEY", pem(privateKey).trim().replace(/\n/g, "\\n"));
    vi.stubEnv("NEO_POLICY_KEY_ID", "2026-11");
    const s = getPolicySigningService()!;
    const signed = await s.sign(BODY);
    expect(signed.keyId).toBe("2026-11");
    const keys = await s.publicKeys();
    expect(keys[0]).toMatchObject({ kid: "2026-11" });
  });

  it("signs with the ephemeral key and the result verifies; a tampered bundle or the wrong key id does not", async () => {
    const s = getPolicySigningService()!;
    const signed = await s.sign(new TextEncoder().encode(canonicalJson(BUNDLE)));
    const keys = await s.publicKeys();
    expect((await verifyPolicyEnvelope(envelopeFor(BUNDLE, signed.sig, signed.keyId), [keys[0]!.jwk])).ok).toBe(true);
    expect((await verifyPolicyEnvelope(envelopeFor({ ...BUNDLE, mode: "child" }, signed.sig, signed.keyId), [keys[0]!.jwk])).ok).toBe(false);
    expect(await verifyPolicyEnvelope(envelopeFor(BUNDLE, signed.sig, "someone-else"), [keys[0]!.jwk])).toEqual({ ok: false, reason: "unknown_key" });
  });
});

describe("Vercel KMS signer", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const exported = publicKey.export({ format: "jwk" });
  const jwks = { keys: [{ kty: "EC", crv: "P-256", x: exported.x, y: exported.y, kid: "kms-key-1", alg: "ES256", use: "sig" }] };
  const bytes = new TextEncoder().encode(canonicalJson(BUNDLE));

  function stubJwks(body: unknown = jwks, ok = true) {
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify(body), { status: ok ? 200 : 500 }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function kmsReturns(encoding: "der" | "ieee-p1363", over: { algorithm?: string; keyId?: string } = {}) {
    kms.signMessage.mockImplementation(async ({ message }: { message: Uint8Array }) => ({
      signature: new Uint8Array(nodeSign("sha256", message, { key: privateKey, dsaEncoding: encoding })),
      keyId: over.keyId ?? "kms-key-1",
      algorithm: over.algorithm ?? "ES256",
      fingerprint: "SHA256:x",
    }));
  }

  beforeEach(() => vi.stubEnv("NEO_POLICY_KMS_ISSUER", "issuer_abc"));

  it("normalizes a DER signature to raw r || s that verifies", async () => {
    stubJwks();
    kmsReturns("der");
    const signed = await getPolicySigningService()!.sign(bytes);
    expect(kms.signMessage).toHaveBeenCalledWith({ issuerId: "issuer_abc", message: bytes });
    expect(signed).toMatchObject({ keyId: "kms-key-1", alg: "ES256" });
    expect(signed.sig).toHaveLength(64);
    expect((await verifyPolicyEnvelope(envelopeFor(BUNDLE, signed.sig, signed.keyId), jwks.keys as never)).ok).toBe(true);
  });

  it("passes a raw r || s signature through", async () => {
    stubJwks();
    kmsReturns("ieee-p1363");
    const signed = await getPolicySigningService()!.sign(bytes);
    expect(signed.sig).toHaveLength(64);
    expect((await verifyPolicyEnvelope(envelopeFor(BUNDLE, signed.sig, signed.keyId), jwks.keys as never)).ok).toBe(true);
  });

  it("refuses a key that is not ES256", async () => {
    stubJwks();
    kmsReturns("der", { algorithm: "RS256" });
    await expect(getPolicySigningService()!.sign(bytes)).rejects.toThrow(/ES256/);
  });

  it("refuses a signature that does not verify against the published key", async () => {
    stubJwks();
    kms.signMessage.mockResolvedValue({ signature: new Uint8Array(64).fill(1), keyId: "kms-key-1", algorithm: "ES256", fingerprint: "x" });
    await expect(getPolicySigningService()!.sign(bytes)).rejects.toThrow(/does not verify/);
  });

  it("signs anyway, with a warning, when the JWKS cannot be fetched", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    kmsReturns("der");
    const signed = await getPolicySigningService()!.sign(bytes);
    expect(signed.sig).toHaveLength(64);
  });

  it("reports the key id it last signed with, or the only published key before that", async () => {
    stubJwks();
    const s = getPolicySigningService()!;
    expect(await s.currentKeyId()).toBe("kms-key-1");
    stubJwks({ keys: [...jwks.keys, { ...jwks.keys[0], kid: "kms-key-2" }] });
    setPolicySigningServiceForTests(undefined);
    const fresh = getPolicySigningService()!;
    expect(await fresh.currentKeyId()).toBeNull();
    kmsReturns("der", { keyId: "kms-key-2" });
    await fresh.sign(bytes);
    expect(await fresh.currentKeyId()).toBe("kms-key-2");
  });

  it("publishes the JWKS keys as { kid, alg, jwk } and caches them", async () => {
    const fetchMock = stubJwks();
    const s = getPolicySigningService()!;
    const keys = await s.publicKeys();
    expect(keys).toEqual([{ kid: "kms-key-1", alg: "ES256", jwk: expect.objectContaining({ kty: "EC", crv: "P-256", x: exported.x, y: exported.y }) }]);
    await s.publicKeys();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://kms.vercel.com/issuer_abc/jwks.json");
  });
});
