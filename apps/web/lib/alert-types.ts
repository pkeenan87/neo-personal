/** Wire types for the alert routes (_specs/owner-alerts.md). Dates are ISO-8601. */

export type AlertKindName =
  | "member_verdict"
  | "member_joined"
  | "member_left"
  | "device_enrolled"
  | "device_offline"
  | "device_removed"
  | "scam_page"
  | "dangerous_site"
  | "remote_access"
  | "unwanted_software"
  | "permission_grant"
  | "scam_in_progress"
  | "breach_detected"
  | "mailbox_forwarding";
export type AlertSeverityName = "low" | "medium" | "high" | "critical";
export type AlertThreshold = "medium" | "high" | "critical" | "off";
export const ALERT_THRESHOLD_VALUES: readonly AlertThreshold[] = ["medium", "high", "critical", "off"];

export interface AlertItem {
  id: string;
  kind: AlertKindName;
  severity: AlertSeverityName;
  title: string;
  body: string;
  subjectUserId: string | null;
  subjectName: string | null;
  verdictId: string | null;
  createdAt: string;
  acknowledgedAt: string | null;
  acknowledgedByName: string | null;
}

/** GET /api/alerts */
export interface AlertListResponse {
  items: AlertItem[];
  nextCursor: string | null;
  /** Open alerts visible to the caller (all of them, not just this page). */
  openCount: number;
  /** Open high or critical alerts visible to the caller (the nav dot). */
  urgentCount: number;
}

/** GET|POST /api/settings/alerts */
export interface AlertSettingsResponse {
  threshold: AlertThreshold;
}
