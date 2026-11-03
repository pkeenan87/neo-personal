/**
 * Compile the effective policy of one device into a signable bundle (_specs/v2-m2-child.md section
 * 4). Pure: no I/O, no clock (`now` is passed in), no signing. Standard and Elder devices get the
 * empty web, apps and screen-time sections, so clients have one code path.
 */
import { createHash } from "node:crypto";
import {
  POLICY_BUNDLE_TTL_MS,
  POLICY_BUNDLE_VERSION,
  WEEKDAYS,
  policyVersionBody,
  type PolicyBundle,
  type ScreenTimeGrant,
} from "@neo/verdict";
import { effectivePolicy, type PolicyLayers } from "./defaults.js";

export { canonicalJson, policyVersionBody, type PolicyBundle, type ScreenTimeGrant } from "@neo/verdict";

export interface CompileBundleInput {
  device: { id: string };
  member: { id: string };
  /** Household, member and device rule layers and the member's mode (birth year, time zone and clock are the inputs below). */
  layers: Omit<PolicyLayers, "birthYear" | "timeZone" | "now">;
  /** Child mode only: decides the age band. */
  birthYear: number | null;
  /** The household's IANA zone; null is UTC. */
  timeZone: string | null;
  now: Date;
  /** Approved extra screen time (slice 3 fills this; empty for now). */
  grants: readonly ScreenTimeGrant[];
}

/** Hex SHA-256 of the canonical bundle body, excluding the timestamps and the version itself. */
export function computePolicyVersion(bundle: Parameters<typeof policyVersionBody>[0]): string {
  return createHash("sha256").update(policyVersionBody(bundle), "utf8").digest("hex");
}

export function compileBundle(input: CompileBundleInput): PolicyBundle {
  const { layers, now } = input;
  const timeZone = input.timeZone ?? "UTC";
  const mode = layers.mode;
  const policy = effectivePolicy({ ...layers, birthYear: input.birthYear, timeZone: input.timeZone, now });
  const child = mode === "child";
  const web = child ? policy.web : undefined;
  const apps = child ? policy.apps : undefined;
  const st = child ? policy.screenTime : undefined;

  const body = {
    v: POLICY_BUNDLE_VERSION as 1,
    deviceId: input.device.id,
    memberId: input.member.id,
    timeZone,
    mode,
    web: {
      categories: [...(web?.categories ?? [])],
      safeSearch: web?.safeSearch ?? false,
      youtubeRestricted: web?.youtubeRestricted ?? ("off" as const),
      allow: [...(web?.allow ?? [])],
      block: [...(web?.block ?? [])],
    },
    apps: {
      block: [...(apps?.block ?? [])],
      requireApproval: apps?.requireApproval ?? false,
      approved: [...(apps?.approved ?? [])],
    },
    screenTime: {
      dailyMinutes: Object.fromEntries(WEEKDAYS.map((d) => [d, st?.dailyMinutes?.[d] ?? null])) as PolicyBundle["screenTime"]["dailyMinutes"],
      downtime: (st?.downtime ?? []).map((w) => ({ start: w.start, end: w.end })),
      warnMinutes: st?.warnMinutes ?? 0,
      allowDuringDowntime: [...(st?.allowDuringDowntime ?? [])],
      grants: child ? input.grants.map((g) => ({ minutes: g.minutes, until: g.until })) : [],
    },
  };
  const policyVersion = computePolicyVersion(body);
  return {
    ...body,
    policyVersion,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + POLICY_BUNDLE_TTL_MS).toISOString(),
  };
}
