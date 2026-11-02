import { PolicyRulesSchema, type PolicyRules, type ProtectionMode } from "@neo/verdict";

/**
 * Code-constant defaults per mode. `standard` reproduces the pre-v2 rules exactly (every
 * correlation/protection rule is off because its window/severity is unset); `child` equals
 * `standard` until M2.
 */
const STANDARD: PolicyRules = {
  remote_access: { unknownPeerSeverity: "high" },
  notify: { ownersNotifyAt: "high" },
};

const ELDER: PolicyRules = {
  remote_access: { unknownPeerSeverity: "critical", sessionWindowMinutes: 30 },
  payments: { underPressureWindowMinutes: 60 },
  notify: { helpersNotifyAt: "high", ownersNotifyAt: "high" },
  devices: { protectionDisabledSeverity: "high" },
};

export const MODE_DEFAULTS: Record<ProtectionMode, PolicyRules> = {
  standard: STANDARD,
  child: STANDARD,
  elder: ELDER,
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    const cur = out[k];
    out[k] = isPlainObject(cur) && isPlainObject(v) ? deepMerge(cur, v) : v;
  }
  return out;
}

export interface PolicyLayers {
  household?: unknown;
  mode: ProtectionMode;
  member?: unknown;
  device?: unknown;
}

/**
 * Effective rules for one device of one member: household → mode defaults → member → device,
 * later layers win, sections merge field by field. A layer that fails `PolicyRulesSchema` is
 * skipped whole (a bad stored policy never disables protection); unknown keys are dropped.
 */
export function effectivePolicy(layers: PolicyLayers): PolicyRules {
  const ordered: unknown[] = [layers.household, MODE_DEFAULTS[layers.mode] ?? MODE_DEFAULTS.standard, layers.member, layers.device];
  let merged: Record<string, unknown> = {};
  for (const layer of ordered) {
    if (layer === undefined || layer === null) continue;
    const parsed = PolicyRulesSchema.safeParse(layer);
    if (!parsed.success) continue;
    merged = deepMerge(merged, parsed.data as Record<string, unknown>);
  }
  return merged as PolicyRules;
}
