/** Test helpers for policy bundles: a real P-256 key, the server's signing recipe, and a bundle builder. */
import { base64urlEncode, canonicalJson, type PolicyBundle, type PolicyPublicJwk } from "@neo/verdict";

export interface TestKey {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: PolicyPublicJwk;
}

export async function makeKey(kid: string): Promise<TestKey> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { kid, privateKey: pair.privateKey, publicJwk: { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y!, kid, alg: "ES256", use: "sig" } };
}

/** Signs exactly what the server does: ES256 over the UTF-8 bytes of canonicalJson(bundle), raw r||s. */
export async function signEnvelope(bundle: unknown, key: TestKey): Promise<{ bundle: unknown; sig: string; keyId: string; alg: "ES256" }> {
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, new TextEncoder().encode(canonicalJson(bundle))));
  return { bundle, sig: base64urlEncode(sig), keyId: key.kid, alg: "ES256" };
}

export function makeBundle(overrides: { mode?: PolicyBundle["mode"]; web?: Partial<PolicyBundle["web"]>; policyVersion?: string; issuedAt?: string; expiresAt?: string; deviceId?: string } = {}): PolicyBundle {
  return {
    v: 1,
    deviceId: overrides.deviceId ?? "d1",
    memberId: "m1",
    policyVersion: overrides.policyVersion ?? "a".repeat(64),
    issuedAt: overrides.issuedAt ?? "2026-11-03T00:00:00.000Z",
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    timeZone: "UTC",
    mode: overrides.mode ?? "child",
    web: { categories: [], safeSearch: false, youtubeRestricted: "off", allow: [], block: [], ...overrides.web },
    apps: { block: [], requireApproval: false, approved: [] },
    screenTime: {
      dailyMinutes: { mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null },
      downtime: [],
      warnMinutes: 0,
      allowDuringDowntime: [],
      grants: [],
    },
  };
}
