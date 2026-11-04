import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PolicyBundleSchema, SIGNAL_DETECTORS, base64urlEncode, canonicalJson, parseSignalEvent, verifyPolicyEnvelope, type PolicyPublicJwk } from "../src/index.js";

const BODY = {
  v: 1 as const,
  deviceId: "11111111-1111-4111-8111-111111111111",
  memberId: "22222222-2222-4222-8222-222222222222",
  policyVersion: "a".repeat(64),
  issuedAt: "2026-11-03T12:00:00.000Z",
  expiresAt: "2026-11-10T12:00:00.000Z",
  timeZone: "UTC",
  mode: "elder" as const,
  web: { categories: [], safeSearch: false, youtubeRestricted: "off" as const, allow: [], block: [] },
  apps: { block: [], requireApproval: false, approved: [] },
  screenTime: { dailyMinutes: { mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null }, downtime: [], warnMinutes: 0, allowDuringDowntime: [], grants: [] },
};
const command = { id: "33333333-3333-4333-8333-333333333333", kind: "end_session", sessionRef: { toolId: "anydesk" }, requiresConfirmation: true, expiresAt: "2026-11-03T12:10:00.000Z" };
const bundle = (commands?: unknown) => ({ ...BODY, ...(commands === undefined ? {} : { commands }) });

describe("PolicyBundleSchema commands (end_session)", () => {
  it("is optional, and a bundle without it is valid", () => {
    expect(PolicyBundleSchema.safeParse(bundle()).success).toBe(true);
    expect(PolicyBundleSchema.safeParse(bundle([command])).success).toBe(true);
    expect(PolicyBundleSchema.safeParse(bundle([{ ...command, sessionRef: { toolId: "anydesk", peerId: "1 2 3" } }])).success).toBe(true);
  });

  it("parses a kind this build does not know, so a newer server never bricks an older client", () => {
    expect(PolicyBundleSchema.safeParse(bundle([{ ...command, kind: "lock_screen" }])).success).toBe(true);
  });

  it("rejects a command with a bad tool id, no confirmation flag, a bad time or no id", () => {
    for (const bad of [{ sessionRef: { toolId: "Any Desk!" } }, { requiresConfirmation: undefined }, { expiresAt: "tomorrow" }, { id: "" }]) {
      expect(PolicyBundleSchema.safeParse(bundle([{ ...command, ...bad }])).success).toBe(false);
    }
  });

  it("is part of the signed bytes: removing or changing the command breaks the signature", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = { ...(publicKey.export({ format: "jwk" }) as object), kid: "k1" } as PolicyPublicJwk;
    const withCmd = bundle([command]);
    const sig = base64urlEncode(sign("sha256", Buffer.from(canonicalJson(withCmd)), { key: privateKey, dsaEncoding: "ieee-p1363" }));
    const envelope = (b: unknown) => ({ bundle: b, sig, keyId: "k1", alg: "ES256" });
    expect((await verifyPolicyEnvelope(envelope(withCmd), [jwk])).ok).toBe(true);
    expect(await verifyPolicyEnvelope(envelope(bundle()), [jwk])).toEqual({ ok: false, reason: "bad_signature" });
    expect(await verifyPolicyEnvelope(envelope(bundle([{ ...command, requiresConfirmation: false }])), [jwk])).toEqual({ ok: false, reason: "bad_signature" });
  });
});

describe("command_result", () => {
  const base = { id: "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f", type: "command", detector: "command_result", observedAt: "2026-11-03T12:00:00.000Z", commandId: "33333333-3333-4333-8333-333333333333", outcome: "done" };

  it("accepts each outcome, with or without a short detail code", () => {
    for (const outcome of ["done", "declined", "failed", "expired"]) expect(parseSignalEvent({ ...base, outcome }).ok).toBe(true);
    expect(parseSignalEvent({ ...base, detail: "not_running" }).ok).toBe(true);
  });

  it("is strict about shape: the type, an unknown outcome, free-text detail and extra keys are refused", () => {
    for (const bad of [{ type: "software" }, { outcome: "exploded" }, { detail: "Free text!" }, { detail: "x".repeat(65) }, { commandId: "nope" }, { extra: 1 }]) {
      expect(parseSignalEvent({ ...base, ...bad }).ok).toBe(false);
    }
    expect(parseSignalEvent({ ...base, commandId: undefined }).ok).toBe(false);
  });

  it("is a client detector", () => {
    expect((SIGNAL_DETECTORS as readonly string[]).includes("command_result")).toBe(true);
  });
});
