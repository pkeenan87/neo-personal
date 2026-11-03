import { PolicyRulesSchema, WEB_CATEGORIES, type PolicyRules, type ProtectionMode, type WebCategory } from "@neo/verdict";

/**
 * Code-constant defaults per mode. `standard` reproduces the pre-v2 rules exactly (every
 * correlation/protection rule is off because its window/severity is unset). `child` is a
 * function of the child's age band (`childDefaults`, _specs/v2-m2-child.md section 3).
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

// ---- Age bands ----------------------------------------------------------

export const AGE_BANDS = ["under_10", "10_13", "14_17"] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

/** The band used when a child has no birth year on file. */
export const DEFAULT_AGE_BAND: AgeBand = "10_13";

export interface AgeBandInfo {
  band: AgeBand;
  /** Age in whole years by calendar year (`year(now in the household zone) - birthYear`); null without a birth year. */
  age: number | null;
  /** True when no birth year is on file, so `DEFAULT_AGE_BAND` was assumed. */
  assumed: boolean;
  /** True when the age is 18 or more: the member is treated as 14-17, and the console says so. */
  adult: boolean;
}

/** The calendar year of `now` in an IANA zone (null or an unknown zone reads as UTC). */
function yearIn(now: Date, timeZone: string | null | undefined): number {
  if (timeZone) {
    try {
      const y = Number(new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" }).format(now));
      if (Number.isInteger(y)) return y;
    } catch {
      // An unknown zone name falls through to UTC.
    }
  }
  return now.getUTCFullYear();
}

/**
 * The age band for a birth year. Only the year is stored, so age is `current year - birth year`
 * and the band changes on 1 January **in the household time zone** (not UTC): a child born in
 * 2016 is 9 until midnight local time on 1 January 2026, then 10. No birth year gives 10-13; 18 or
 * more gives 14-17 with `adult` set; a birth year in the future (a zone ahead of UTC) counts as
 * under 10.
 */
export function ageBandInfo(birthYear: number | null | undefined, now: Date, timeZone?: string | null): AgeBandInfo {
  if (birthYear === null || birthYear === undefined || !Number.isInteger(birthYear)) return { band: DEFAULT_AGE_BAND, age: null, assumed: true, adult: false };
  const age = yearIn(now, timeZone) - birthYear;
  const band: AgeBand = age < 10 ? "under_10" : age < 14 ? "10_13" : "14_17";
  return { band, age, assumed: false, adult: age >= 18 };
}

export function ageBand(birthYear: number | null | undefined, now: Date, timeZone?: string | null): AgeBand {
  return ageBandInfo(birthYear, now, timeZone).band;
}

const MINUTES_PER_HOUR = 60;

const CHILD_BANDS: Record<AgeBand, { categories: readonly WebCategory[]; youtube: "strict" | "moderate"; requireApproval: boolean; weekday: number | null; weekend: number | null; downtime: { start: string; end: string } }> = {
  under_10: {
    categories: WEB_CATEGORIES,
    youtube: "strict",
    requireApproval: true,
    weekday: 1 * MINUTES_PER_HOUR,
    weekend: 2 * MINUTES_PER_HOUR,
    downtime: { start: "19:30", end: "07:00" },
  },
  "10_13": {
    categories: ["adult", "gambling", "weapons", "self_harm", "drugs", "proxy_vpn", "dating"],
    youtube: "moderate",
    requireApproval: true,
    weekday: 2 * MINUTES_PER_HOUR,
    weekend: 3 * MINUTES_PER_HOUR,
    downtime: { start: "21:00", end: "07:00" },
  },
  "14_17": {
    categories: ["adult", "gambling", "self_harm", "drugs", "proxy_vpn"],
    youtube: "moderate",
    requireApproval: false,
    weekday: null,
    weekend: null,
    downtime: { start: "23:00", end: "06:00" },
  },
};

/**
 * Child-mode defaults for one age band (the spec's table). Remote-access and protection-disabled
 * rules are Elder's: an unknown remote tool or session on a child's device is serious, and so is
 * Neo's protection being turned off. Every value can be overridden by a member or device layer.
 */
export function childDefaults(band: AgeBand = DEFAULT_AGE_BAND): PolicyRules {
  const b = CHILD_BANDS[band];
  return {
    web: { categories: [...b.categories], safeSearch: true, youtubeRestricted: b.youtube, allow: [], block: [] },
    apps: { block: [], requireApproval: b.requireApproval, approved: [] },
    screenTime: {
      dailyMinutes: { mon: b.weekday, tue: b.weekday, wed: b.weekday, thu: b.weekday, fri: b.weekday, sat: b.weekend, sun: b.weekend },
      downtime: [{ ...b.downtime }],
      warnMinutes: 10,
      allowDuringDowntime: [],
    },
    remote_access: { unknownPeerSeverity: "critical", sessionWindowMinutes: 30 },
    notify: { helpersNotifyAt: "high", ownersNotifyAt: "high", childRequestsTo: "owners" },
    devices: { protectionDisabledSeverity: "high" },
  };
}

/** Mode defaults. `child` here is the 10-13 band (the band used when none is known); use `childDefaults(band)` for a real child. */
export const MODE_DEFAULTS: Record<ProtectionMode, PolicyRules> = {
  standard: STANDARD,
  child: childDefaults(DEFAULT_AGE_BAND),
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
  /** Child mode only: the child's birth year (null or absent assumes the 10-13 band). */
  birthYear?: number | null;
  /** Child mode only: the household's IANA time zone, which decides when the age band changes (null or absent is UTC). */
  timeZone?: string | null;
  /** Child mode only: the evaluation time for the age band (default: now). */
  now?: Date;
  member?: unknown;
  device?: unknown;
}

/**
 * Effective rules for one device of one member: household → mode defaults → member → device,
 * later layers win, sections merge field by field. A layer that fails `PolicyRulesSchema` is
 * skipped whole (a bad stored policy never disables protection); unknown keys are dropped.
 */
export function effectivePolicy(layers: PolicyLayers): PolicyRules {
  const modeDefaults = layers.mode === "child" ? childDefaults(ageBand(layers.birthYear, layers.now ?? new Date(), layers.timeZone)) : (MODE_DEFAULTS[layers.mode] ?? MODE_DEFAULTS.standard);
  const ordered: unknown[] = [layers.household, modeDefaults, layers.member, layers.device];
  let merged: Record<string, unknown> = {};
  for (const layer of ordered) {
    if (layer === undefined || layer === null) continue;
    const parsed = PolicyRulesSchema.safeParse(layer);
    if (!parsed.success) continue;
    merged = deepMerge(merged, parsed.data as Record<string, unknown>);
  }
  return merged as PolicyRules;
}
