/**
 * The policy public keys the extension trusts (`_specs/v2-m2-child.md` section 4). Pinned at build
 * time: `NEO_POLICY_PUBKEYS` (a JSON array of P-256 JWKs, each with its `kid`) replaces the default,
 * which is the production KMS public key (a public key; fetched from /api/devices/policy/keys). A
 * self-hoster builds with their own key. The server's keys endpoint is never consulted at run time.
 */
import { PolicyPublicJwkSchema, type PolicyPublicJwk } from "@neo/verdict";
import defaultKeys from "./default-keys.json";

/** Injected by `wxt.config.ts` (`vite.define`); undefined under vitest. */
declare const __NEO_POLICY_PUBKEYS__: string | undefined;

/** Parses a JSON array of JWKs that each carry a `kid`; null when it is not one (the build fails on that). */
export function parsePolicyKeys(raw: string | undefined | null): PolicyPublicJwk[] | null {
  if (raw === undefined || raw === null || raw.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const keys: PolicyPublicJwk[] = [];
    for (const item of parsed) {
      const key = PolicyPublicJwkSchema.safeParse(item);
      if (!key.success || !key.data.kid) return null;
      keys.push(key.data);
    }
    return keys;
  } catch {
    return null;
  }
}

let testKeys: PolicyPublicJwk[] | null = null;
/** Test-only: pin other keys for this process (the real ones are fixed at build time). */
export function __setPolicyKeysForTests(keys: PolicyPublicJwk[] | null): void {
  testKeys = keys;
}

/** The keys this build verifies policy bundles against. */
export function policyKeys(): PolicyPublicJwk[] {
  if (testKeys) return testKeys;
  const injected = typeof __NEO_POLICY_PUBKEYS__ === "string" ? parsePolicyKeys(__NEO_POLICY_PUBKEYS__) : null;
  return injected ?? (defaultKeys as PolicyPublicJwk[]);
}
