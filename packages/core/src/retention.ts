/**
 * Per-household data retention settings (_specs/v2-m4-hardening.md section 1). Pure: the web app and `@neo/db` share
 * one definition of the kinds, bounds and defaults. A household that never set a value gets the default (`null` in the database).
 *
 * `incidents` are owner alerts: an alert goes after `incidents_days` (default 180, the pre-M4 rule), and an acknowledged
 * alert goes sooner, after the lesser of 90 days and that setting. `schedule_runs` is the job log, not household data: a fixed 90 days.
 */
export const RETENTION_KINDS = ["signals", "incidents", "childRequests", "memory"] as const;
export type RetentionKind = (typeof RETENTION_KINDS)[number];

export interface RetentionBound {
  min: number;
  max: number;
  default: number;
}

export const RETENTION_BOUNDS: Record<RetentionKind, RetentionBound> = {
  signals: { min: 7, max: 365, default: 30 },
  incidents: { min: 30, max: 1095, default: 180 },
  childRequests: { min: 7, max: 365, default: 90 },
  memory: { min: 30, max: 1095, default: 365 },
};

/** Days per kind. */
export type RetentionSettings = Record<RetentionKind, number>;

export const DEFAULT_RETENTION: RetentionSettings = {
  signals: RETENTION_BOUNDS.signals.default,
  incidents: RETENTION_BOUNDS.incidents.default,
  childRequests: RETENTION_BOUNDS.childRequests.default,
  memory: RETENTION_BOUNDS.memory.default,
};

/** A whole number of days within the kind's bounds. */
export function isValidRetentionDays(kind: RetentionKind, n: unknown): n is number {
  const b = RETENTION_BOUNDS[kind];
  return typeof n === "number" && Number.isInteger(n) && n >= b.min && n <= b.max;
}
