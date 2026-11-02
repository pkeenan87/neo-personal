import { z } from "zod";

/** Protection mode of a member (`members.mode`). `child` equals `standard` until M2. */
export const PROTECTION_MODES = ["standard", "child", "elder"] as const;
export type ProtectionMode = (typeof PROTECTION_MODES)[number];

// Local copy of SEVERITIES: importing it from "./index.js" would be a cycle (index re-exports this file).
const SeveritySchema = z.enum(["low", "medium", "high", "critical"]);
const Minutes = z.number().int().min(1).max(24 * 60);

/**
 * Policy rules, one layer (household, mode defaults, member or device). Every section and field
 * is optional so a layer can be partial; `effectivePolicy` (`@neo/core`) merges layers. Unknown
 * keys are stripped. `web`, `apps` and `screen_time` are M2 placeholders and ignored by the engine.
 */
export const PolicyRulesSchema = z.object({
  web: z.unknown().optional(),
  apps: z.unknown().optional(),
  screen_time: z.unknown().optional(),
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
    })
    .optional(),
  devices: z
    .object({
      /** Severity of a `protection_disabled` server signal. Unset = recorded only. */
      protectionDisabledSeverity: SeveritySchema.optional(),
    })
    .optional(),
});

export type PolicyRules = z.infer<typeof PolicyRulesSchema>;
