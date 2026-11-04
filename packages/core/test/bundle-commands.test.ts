import { PolicyBundleSchema } from "@neo/verdict";
import { describe, expect, it } from "vitest";
import { compileBundle, computePolicyVersion, type CompileBundleInput } from "../src/index.js";

const NOW = new Date("2026-11-02T15:00:00.000Z");
const ids = { device: { id: "11111111-1111-4111-8111-111111111111" }, member: { id: "22222222-2222-4222-8222-222222222222" } };

function input(over: Partial<CompileBundleInput> = {}): CompileBundleInput {
  return { ...ids, layers: { mode: "standard" }, birthYear: null, timeZone: null, now: NOW, grants: [], ...over };
}

function versionOf(b: ReturnType<typeof compileBundle>): string {
  const { issuedAt: _i, expiresAt: _e, policyVersion: _p, ...body } = b;
  return computePolicyVersion(body);
}

describe("compileBundle commands (end_session)", () => {
  const cmd = (id: string, expiresAt = "2026-11-02T15:10:00.000Z") => ({ id, kind: "end_session", sessionRef: { toolId: "anydesk", peerId: "1 2 3" }, requiresConfirmation: true, expiresAt });
  const a = cmd("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  const b = cmd("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");

  it("leaves a bundle without commands as it was: no key, same version", () => {
    const plain = compileBundle(input());
    const expired = cmd("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "2026-11-02T14:59:59.999Z");
    for (const none of [{}, { commands: [] }, { commands: [expired] }]) {
      const other = compileBundle(input(none));
      expect("commands" in other).toBe(false);
      expect(other.policyVersion).toBe(plain.policyVersion);
    }
    expect(PolicyBundleSchema.safeParse(plain).success).toBe(true);
  });

  it("carries a pending command in every mode, validly, and it changes the version", () => {
    for (const mode of ["standard", "elder", "child"] as const) {
      const base = input({ layers: { mode }, birthYear: mode === "child" ? 2015 : null });
      const without = compileBundle(base);
      const withCmd = compileBundle({ ...base, commands: [a] });
      expect(withCmd.commands).toEqual([a]);
      expect(PolicyBundleSchema.safeParse(withCmd).success).toBe(true);
      expect(withCmd.policyVersion).not.toBe(without.policyVersion);
      expect(versionOf(withCmd)).toBe(withCmd.policyVersion);
    }
  });

  it("sorts commands by id whatever order they arrive in, and drops the expired ones", () => {
    const one = compileBundle(input({ commands: [b, a] }));
    const two = compileBundle(input({ commands: [a, b] }));
    expect(one.commands?.map((c) => c.id)).toEqual([a.id, b.id]);
    expect(one.policyVersion).toBe(two.policyVersion);
    const expired = cmd("dddddddd-dddd-4ddd-8ddd-dddddddddddd", NOW.toISOString());
    expect(compileBundle(input({ commands: [expired, a] })).commands).toEqual([a]);
  });

  it("changes the version with the command's own fields, not with the issue time", () => {
    const base = compileBundle(input({ commands: [a] })).policyVersion;
    expect(compileBundle(input({ commands: [{ ...a, requiresConfirmation: false }] })).policyVersion).not.toBe(base);
    expect(compileBundle(input({ commands: [{ ...a, sessionRef: { toolId: "teamviewer" } }] })).policyVersion).not.toBe(base);
    expect(compileBundle(input({ commands: [{ ...a, expiresAt: "2026-11-02T15:09:00.000Z" }] })).policyVersion).not.toBe(base);
    expect(compileBundle(input({ commands: [a], now: new Date(NOW.getTime() + 60_000) })).policyVersion).toBe(base);
  });
});
