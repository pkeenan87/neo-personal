/**
 * Signed policy bundles (_specs/v2-m2-child.md section 4): the shape a device enforces, the canonical
 * JSON the signature covers, and an ES256 verifier built on WebCrypto only (Node 22+ and browsers:
 * no `Buffer`, no `node:crypto`), so the extension and tests share one implementation.
 */
import { z } from "zod";
import { AppRefSchema, DowntimeWindowSchema, PROTECTION_MODES, CategorySchema, YOUTUBE_LEVELS } from "./policy.js";

export const POLICY_BUNDLE_VERSION = 1;
/** A bundle is valid for seven days from `issuedAt`; clients keep enforcing past it (expiry only flags it as stale). */
export const POLICY_BUNDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const POLICY_ALG = "ES256";

// ---- Canonical JSON ------------------------------------------------------

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit (the default `sort()` order; every key in a
 * bundle is ASCII), no whitespace, arrays in the order given, strings as `JSON.stringify` writes them
 * (non-ASCII is kept as UTF-8, not escaped), `undefined` properties dropped, `null` kept. Numbers must
 * be finite (a bundle has only integers). The signature covers the UTF-8 bytes of this string.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new Error("canonicalJson: non-finite number");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
      const obj = value as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of Object.keys(obj).sort()) {
        const v = obj[key];
        if (v === undefined) continue;
        parts.push(`${JSON.stringify(key)}:${canonicalJson(v)}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      throw new Error(`canonicalJson: unsupported ${typeof value}`);
  }
}

// ---- Bundle schema -------------------------------------------------------

const Iso = z.string().datetime({ offset: true });
const DailyMinutes = z.number().int().min(0).max(24 * 60).nullable();

export const ScreenTimeGrantSchema = z.object({
  minutes: z.number().int().min(1).max(24 * 60),
  until: Iso,
});
export type ScreenTimeGrant = z.infer<typeof ScreenTimeGrantSchema>;

/** A site a parent allowed for a limited time (an approved one-hour "unblock"): enforced like `web.allow` until `until`. */
export const AllowOnceGrantSchema = z.object({
  domain: z.string().min(3).max(253),
  until: Iso,
});
export type AllowOnceGrant = z.infer<typeof AllowOnceGrantSchema>;

/**
 * A command for the device (_specs/v2-m3-cutover.md section 4): today only `end_session`. `kind` is a plain
 * string so a bundle with a kind a client does not know still parses (it is ignored).
 */
export const BundleCommandSchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.string().min(1).max(32),
  sessionRef: z.object({
    toolId: z.string().regex(/^[a-z0-9_-]{1,64}$/),
    peerId: z.string().min(1).max(64).optional(),
  }),
  /** The person at the device must confirm on screen before anything is closed. */
  requiresConfirmation: z.boolean(),
  /** The device ignores the command from this moment (10 minutes after it was requested). */
  expiresAt: Iso,
});
export type BundleCommand = z.infer<typeof BundleCommandSchema>;

/** Every section is present for every mode: Standard and Elder devices get the empty form, so clients have one code path. */
export const PolicyBundleSchema = z.object({
  v: z.literal(POLICY_BUNDLE_VERSION),
  deviceId: z.string().min(1).max(64),
  memberId: z.string().min(1).max(64),
  /** Hex SHA-256 of the canonical bundle without `issuedAt`, `expiresAt` and `policyVersion`. */
  policyVersion: z.string().regex(/^[0-9a-f]{64}$/),
  issuedAt: Iso,
  expiresAt: Iso,
  /** IANA name of the household zone (UTC when none is set). */
  timeZone: z.string().min(1).max(64),
  mode: z.enum(PROTECTION_MODES),
  web: z.object({
    categories: z.array(CategorySchema),
    safeSearch: z.boolean(),
    youtubeRestricted: z.enum(YOUTUBE_LEVELS),
    allow: z.array(z.string()),
    block: z.array(z.string()),
    /** Temporary allows (child requests); absent, not empty, when there are none, so a bundle without them keeps its `policyVersion`. */
    allowOnce: z.array(AllowOnceGrantSchema).optional(),
  }),
  apps: z.object({
    block: z.array(AppRefSchema),
    requireApproval: z.boolean(),
    approved: z.array(AppRefSchema),
  }),
  screenTime: z.object({
    /** Minutes per weekday; null is "no limit". */
    dailyMinutes: z.object({ mon: DailyMinutes, tue: DailyMinutes, wed: DailyMinutes, thu: DailyMinutes, fri: DailyMinutes, sat: DailyMinutes, sun: DailyMinutes }),
    downtime: z.array(DowntimeWindowSchema),
    warnMinutes: z.number().int().min(0).max(120),
    allowDuringDowntime: z.array(AppRefSchema),
    grants: z.array(ScreenTimeGrantSchema),
  }),
  /** Pending commands for this device; absent, not empty, when there are none, so a bundle without them keeps its `policyVersion`. */
  commands: z.array(BundleCommandSchema).optional(),
});
export type PolicyBundle = z.infer<typeof PolicyBundleSchema>;

/** The canonical text `policyVersion` is the SHA-256 of: the bundle without its timestamps and version. */
export function policyVersionBody(bundle: Omit<PolicyBundle, "issuedAt" | "expiresAt" | "policyVersion"> & Partial<Pick<PolicyBundle, "issuedAt" | "expiresAt" | "policyVersion">>): string {
  const { issuedAt: _i, expiresAt: _e, policyVersion: _p, ...body } = bundle;
  void _i;
  void _e;
  void _p;
  return canonicalJson(body);
}

// ---- Envelope ------------------------------------------------------------

export const PolicyEnvelopeSchema = z.object({
  bundle: PolicyBundleSchema,
  /** base64url (no padding) of the raw 64-byte ECDSA signature, r || s. */
  sig: z.string().regex(/^[A-Za-z0-9_-]+$/),
  keyId: z.string().min(1).max(256),
  alg: z.literal(POLICY_ALG),
});
export type PolicyEnvelope = z.infer<typeof PolicyEnvelopeSchema>;

/** An EC P-256 public key as a JWK (RFC 7517), with the `kid` it is published under. */
export const PolicyPublicJwkSchema = z.object({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: z.string().min(1),
  y: z.string().min(1),
  kid: z.string().min(1).optional(),
  alg: z.string().optional(),
  use: z.string().optional(),
});
export type PolicyPublicJwk = z.infer<typeof PolicyPublicJwkSchema>;

/** One entry of `GET /api/devices/policy/keys`. */
export interface PolicyKeyEntry {
  kid: string;
  alg: typeof POLICY_ALG;
  jwk: PolicyPublicJwk;
}

export function base64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Strict base64url (no padding, no other characters); null when malformed. */
export function base64urlDecode(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  try {
    const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export type PolicyVerifyResult =
  | { ok: true; bundle: PolicyBundle }
  | { ok: false; reason: "malformed" | "unknown_key" | "bad_signature" };

/** What a verifier accepts as a trusted key: a JWK carrying its `kid`, or a `{ kid, jwk }` entry from the keys endpoint. */
export type PolicyTrustedKey = PolicyPublicJwk | PolicyKeyEntry;

function normalizeKey(key: PolicyTrustedKey): { kid: string; jwk: PolicyPublicJwk } | null {
  const entry = key as Partial<PolicyKeyEntry>;
  if (entry.jwk && entry.kid) {
    const jwk = PolicyPublicJwkSchema.safeParse(entry.jwk);
    return jwk.success ? { kid: entry.kid, jwk: jwk.data } : null;
  }
  const jwk = PolicyPublicJwkSchema.safeParse(key);
  return jwk.success && jwk.data.kid ? { kid: jwk.data.kid, jwk: jwk.data } : null;
}

/**
 * Verify a policy envelope against pinned keys: the schema, the `alg`, a key with `kid === keyId`,
 * and the ECDSA P-256 / SHA-256 signature over the UTF-8 bytes of `canonicalJson(bundle)`. Expiry is
 * not checked (a device keeps enforcing its last valid bundle past `expiresAt`). Never throws.
 */
export async function verifyPolicyEnvelope(envelope: unknown, keys: readonly PolicyTrustedKey[]): Promise<PolicyVerifyResult> {
  const parsed = PolicyEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) return { ok: false, reason: "malformed" };
  const { bundle, sig, keyId } = parsed.data;
  // The signed bytes are the bundle as sent, not the parsed copy: a newer server may add fields this schema strips.
  const signed = (envelope as { bundle: unknown }).bundle;
  const raw = base64urlDecode(sig);
  if (!raw || raw.length !== 64) return { ok: false, reason: "malformed" };
  const key = keys.map(normalizeKey).find((k) => k?.kid === keyId);
  if (!key) return { ok: false, reason: "unknown_key" };
  try {
    const { kty, crv, x, y } = key.jwk;
    const cryptoKey = await crypto.subtle.importKey("jwk", { kty, crv, x, y, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, cryptoKey, raw, new TextEncoder().encode(canonicalJson(signed)));
    return ok ? { ok: true, bundle } : { ok: false, reason: "bad_signature" };
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
}
