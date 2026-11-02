import { z } from "zod";

/** Protection mode of a member (`members.mode`). */
export const PROTECTION_MODES = ["standard", "child", "elder"] as const;
export type ProtectionMode = (typeof PROTECTION_MODES)[number];

// Local copy of SEVERITIES: importing it from "./index.js" would be a cycle (index re-exports this file).
const SeveritySchema = z.enum(["low", "medium", "high", "critical"]);
const Minutes = z.number().int().min(1).max(24 * 60);

// ---- Child policy (_specs/v2-m2-child.md section 3) ---------------------
//
// Every field is optional and carries no zod default: `effectivePolicy` parses each layer on its
// own and merges them, so a parse-time default would be stamped into every layer and override the
// ones below it. Defaults live in `childDefaults` (@neo/core).

/** Web categories a Child policy can block. A fixed set: clients hold the domain data for each. */
export const WEB_CATEGORIES = ["adult", "gambling", "weapons", "self_harm", "drugs", "proxy_vpn", "social", "games", "streaming", "dating"] as const;
export type WebCategory = (typeof WEB_CATEGORIES)[number];
export const CategorySchema = z.enum(WEB_CATEGORIES);

export const YOUTUBE_LEVELS = ["off", "moderate", "strict"] as const;
export type YoutubeLevel = (typeof YOUTUBE_LEVELS)[number];

export const CHILD_REQUEST_TARGETS = ["owners", "helpers"] as const;
export type ChildRequestTarget = (typeof CHILD_REQUEST_TARGETS)[number];

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const MAX_POLICY_DOMAINS = 200;
export const MAX_POLICY_APP_REFS = 100;
export const MAX_DOWNTIME_WINDOWS = 6;

/**
 * A registrable-looking hostname for a block or allow list: lowercase, at least two dot-separated
 * labels of letters, digits and hyphens (no leading or trailing hyphen), a non-numeric last label
 * (so an IP address is not a domain), 253 characters at most. Punycode (`xn--`) labels are fine.
 */
const PolicyDomainSchema = z
  .string()
  .min(3)
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/, "must be a lowercase domain such as example.com");

const BoundedName = z.string().trim().min(1).max(128);
/** Basename only: an image name never carries a path. */
const ImageName = BoundedName.refine((v) => !v.includes("/") && !v.includes("\\"), { message: "must be a file name, not a path" });
const BundleId = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9]+(\.[A-Za-z0-9-]+)+$/, "must look like a reverse-DNS bundle id");

/**
 * An app, by signer plus image name (Windows) or by macOS bundle id. `signer` and `image` are each
 * optional but at least one is required; a bundle id stands alone.
 */
export const AppRefSchema = z.union([
  z.object({ bundleId: BundleId }).strict(),
  z
    .object({ signer: BoundedName.optional(), image: ImageName.optional() })
    .strict()
    .refine((a) => a.signer !== undefined || a.image !== undefined, { message: "an app needs a signer, an image name or a bundle id" }),
]);
export type AppRef = z.infer<typeof AppRefSchema>;

const AppRefs = z.array(AppRefSchema).max(MAX_POLICY_APP_REFS);

/** `HH:MM`, 24-hour, zero padded. */
const TimeOfDay = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "must be HH:MM (24-hour)");
/** Whole minutes in a day, or null for "no limit". */
const DailyMinutes = z.number().int().min(0).max(24 * 60).nullable();

export const WebRulesSchema = z.object({
  categories: z.array(CategorySchema).max(WEB_CATEGORIES.length).refine((a) => new Set(a).size === a.length, { message: "duplicate category" }).optional(),
  safeSearch: z.boolean().optional(),
  youtubeRestricted: z.enum(YOUTUBE_LEVELS).optional(),
  allow: z.array(PolicyDomainSchema).max(MAX_POLICY_DOMAINS).optional(),
  block: z.array(PolicyDomainSchema).max(MAX_POLICY_DOMAINS).optional(),
});
export type WebRules = z.infer<typeof WebRulesSchema>;

export const AppsRulesSchema = z.object({
  block: AppRefs.optional(),
  requireApproval: z.boolean().optional(),
  approved: AppRefs.optional(),
});
export type AppsRules = z.infer<typeof AppsRulesSchema>;

export const DowntimeWindowSchema = z.object({ start: TimeOfDay, end: TimeOfDay });
export type DowntimeWindow = z.infer<typeof DowntimeWindowSchema>;

export const ScreenTimeRulesSchema = z.object({
  dailyMinutes: z
    .object({
      mon: DailyMinutes.optional(),
      tue: DailyMinutes.optional(),
      wed: DailyMinutes.optional(),
      thu: DailyMinutes.optional(),
      fri: DailyMinutes.optional(),
      sat: DailyMinutes.optional(),
      sun: DailyMinutes.optional(),
    })
    .optional(),
  /** A window may cross midnight (`start` later than `end`). */
  downtime: z.array(DowntimeWindowSchema).max(MAX_DOWNTIME_WINDOWS).optional(),
  warnMinutes: z.number().int().min(0).max(120).optional(),
  allowDuringDowntime: AppRefs.optional(),
});
export type ScreenTimeRules = z.infer<typeof ScreenTimeRulesSchema>;

/**
 * Policy rules, one layer (household, mode defaults, member or device). Every section and field
 * is optional so a layer can be partial; `effectivePolicy` (`@neo/core`) merges layers. Unknown
 * keys are stripped.
 */
export const PolicyRulesSchema = z.object({
  web: WebRulesSchema.optional(),
  apps: AppsRulesSchema.optional(),
  screenTime: ScreenTimeRulesSchema.optional(),
  remote_access: z
    .object({
      /** Severity of an incoming session from a peer not in the expected tool's `peerIds`. */
      unknownPeerSeverity: SeveritySchema.optional(),
      /** Window after an incoming session in which an install/permission grant correlates. Unset = rule off. */
      sessionWindowMinutes: Minutes.optional(),
    })
    .optional(),
  payments: z
    .object({
      /** Window after a scam page / incoming session in which a payment page correlates. Unset = rule off. */
      underPressureWindowMinutes: Minutes.optional(),
    })
    .optional(),
  notify: z
    .object({
      helpersNotifyAt: SeveritySchema.optional(),
      ownersNotifyAt: SeveritySchema.optional(),
      /** Who gets a child's requests (more time, unblock a site, install an app). Default `owners`. */
      childRequestsTo: z.enum(CHILD_REQUEST_TARGETS).optional(),
    })
    .optional(),
  devices: z
    .object({
      /** Severity of a `protection_disabled` server signal and of a `tamper_detected` signal. Unset = recorded only. */
      protectionDisabledSeverity: SeveritySchema.optional(),
    })
    .optional(),
});

export type PolicyRules = z.infer<typeof PolicyRulesSchema>;
