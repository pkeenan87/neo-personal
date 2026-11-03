import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PolicyBundleSchema,
  base64urlDecode,
  base64urlEncode,
  canonicalJson,
  policyVersionBody,
  verifyPolicyEnvelope,
  type PolicyBundle,
  type PolicyPublicJwk,
} from "../src/index.js";

const BUNDLE_BODY = {
  v: 1 as const,
  deviceId: "11111111-1111-4111-8111-111111111111",
  memberId: "22222222-2222-4222-8222-222222222222",
  timeZone: "America/New_York",
  mode: "child" as const,
  web: { categories: ["adult" as const], safeSearch: true, youtubeRestricted: "moderate" as const, allow: [], block: ["bad.example"] },
  apps: { block: [{ bundleId: "com.roblox.Roblox" }], requireApproval: true, approved: [{ signer: "Mozilla", image: "firefox.exe" }] },
  screenTime: {
    dailyMinutes: { mon: 120, tue: 120, wed: 120, thu: 120, fri: 120, sat: 180, sun: null },
    downtime: [{ start: "21:00", end: "07:00" }],
    warnMinutes: 10,
    allowDuringDowntime: [],
    grants: [],
  },
};

function bundle(over: Partial<PolicyBundle> = {}): PolicyBundle {
  const policyVersion = createHash("sha256").update(policyVersionBody(BUNDLE_BODY), "utf8").digest("hex");
  return { ...BUNDLE_BODY, policyVersion, issuedAt: "2026-11-02T12:00:00.000Z", expiresAt: "2026-11-09T12:00:00.000Z", ...over };
}

describe("canonicalJson", () => {
  it("sorts keys, drops whitespace and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: [3, 1, 2], c: { z: true, y: null } })).toBe('{"a":[3,1,2],"b":1,"c":{"y":null,"z":true}}');
  });

  it("does not depend on insertion order, at any depth", () => {
    expect(canonicalJson({ x: { b: 1, a: 2 }, y: [{ q: 1, p: 2 }] })).toBe(canonicalJson({ y: [{ p: 2, q: 1 }], x: { a: 2, b: 1 } }));
  });

  it("keeps non-ASCII text as UTF-8 and escapes only what JSON must", () => {
    const text = canonicalJson({ name: "Zoë ☃ \u{1F600}", quote: 'a"b\\c\n' });
    expect(text).toBe('{"name":"Zoë ☃ \u{1F600}","quote":"a\\"b\\\\c\\n"}');
    // The bytes that get signed are UTF-8.
    expect(new TextEncoder().encode(text).length).toBeGreaterThan(text.length);
  });

  it("drops undefined properties, keeps null, and refuses non-finite numbers", () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
    expect(() => canonicalJson({ a: Infinity })).toThrow();
  });
});

describe("PolicyBundleSchema", () => {
  it("accepts a full bundle and rejects a missing section or a bad version", () => {
    expect(PolicyBundleSchema.safeParse(bundle()).success).toBe(true);
    const noWeb: Partial<PolicyBundle> = bundle();
    delete noWeb.web;
    expect(PolicyBundleSchema.safeParse(noWeb).success).toBe(false);
    expect(PolicyBundleSchema.safeParse({ ...bundle(), v: 2 }).success).toBe(false);
    expect(PolicyBundleSchema.safeParse({ ...bundle(), policyVersion: "xyz" }).success).toBe(false);
  });
});

describe("policyVersionBody", () => {
  it("excludes the timestamps and the version itself", () => {
    const a = policyVersionBody(bundle());
    const b = policyVersionBody(bundle({ issuedAt: "2030-01-01T00:00:00.000Z", expiresAt: "2030-01-08T00:00:00.000Z", policyVersion: "0".repeat(64) }));
    expect(a).toBe(b);
    expect(a).not.toContain("issuedAt");
    expect(a).not.toContain("policyVersion");
  });
});

describe("base64url", () => {
  it("round-trips bytes and rejects other alphabets", () => {
    const bytes = new Uint8Array([0, 250, 251, 252, 253, 254, 255, 1]);
    const text = base64urlEncode(bytes);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect([...(base64urlDecode(text) ?? [])]).toEqual([...bytes]);
    expect(base64urlDecode("ab+/")).toBeNull();
    expect(base64urlDecode("abc=")).toBeNull();
    expect(base64urlDecode("a")).toBeNull();
  });
});

describe("verifyPolicyEnvelope", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const exported = publicKey.export({ format: "jwk" });
  const jwk: PolicyPublicJwk = { kty: "EC", crv: "P-256", x: exported.x!, y: exported.y!, kid: "key-1" };

  function envelope(b: PolicyBundle = bundle(), keyId = "key-1") {
    const sig = sign("sha256", new TextEncoder().encode(canonicalJson(b)), { key: privateKey, dsaEncoding: "ieee-p1363" });
    return { bundle: b, sig: base64urlEncode(new Uint8Array(sig)), keyId, alg: "ES256" as const };
  }

  it("verifies a signature made over the canonical bundle (JWK with kid, or a keys-endpoint entry)", async () => {
    const r = await verifyPolicyEnvelope(envelope(), [jwk]);
    expect(r).toMatchObject({ ok: true, bundle: { deviceId: BUNDLE_BODY.deviceId } });
    expect((await verifyPolicyEnvelope(envelope(), [{ kid: "key-1", alg: "ES256", jwk }])).ok).toBe(true);
  });

  it("rejects a tampered byte anywhere in the bundle", async () => {
    const env = envelope();
    const tampered = { ...env, bundle: { ...env.bundle, apps: { ...env.bundle.apps, requireApproval: false } } };
    expect(await verifyPolicyEnvelope(tampered, [jwk])).toEqual({ ok: false, reason: "bad_signature" });
    const flipped = base64urlDecode(env.sig)!;
    flipped[10] = flipped[10]! ^ 1;
    expect(await verifyPolicyEnvelope({ ...env, sig: base64urlEncode(flipped) }, [jwk])).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects an unknown key id and a key that did not sign", async () => {
    expect(await verifyPolicyEnvelope(envelope(bundle(), "other"), [jwk])).toEqual({ ok: false, reason: "unknown_key" });
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" });
    expect(await verifyPolicyEnvelope(envelope(), [{ kty: "EC", crv: "P-256", x: other.x!, y: other.y!, kid: "key-1" }])).toEqual({ ok: false, reason: "bad_signature" });
    // A key without a kid can never match.
    const noKid: PolicyPublicJwk = { ...jwk };
    delete noKid.kid;
    expect(await verifyPolicyEnvelope(envelope(), [noKid])).toEqual({ ok: false, reason: "unknown_key" });
  });

  it("rejects malformed envelopes: wrong alg, short signature, junk", async () => {
    const env = envelope();
    expect((await verifyPolicyEnvelope({ ...env, alg: "EdDSA" }, [jwk])).ok).toBe(false);
    expect(await verifyPolicyEnvelope({ ...env, sig: base64urlEncode(new Uint8Array(63)) }, [jwk])).toEqual({ ok: false, reason: "malformed" });
    expect(await verifyPolicyEnvelope(null, [jwk])).toEqual({ ok: false, reason: "malformed" });
    expect(await verifyPolicyEnvelope({}, [jwk])).toEqual({ ok: false, reason: "malformed" });
  });

  it("verifies the bundle as sent when a newer server adds a field this schema does not know", async () => {
    const extended = { ...bundle(), futureField: { a: 1 } } as unknown as PolicyBundle;
    const r = await verifyPolicyEnvelope(envelope(extended), [jwk]);
    expect(r.ok).toBe(true);
  });
});
