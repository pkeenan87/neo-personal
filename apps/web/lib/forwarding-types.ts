/** Wire types for GET|POST /api/settings/forwarding (shared by the route and the settings page). */

export type InboundMessageStatus = "received" | "analyzing" | "done" | "rejected" | "over_cap" | "failed";

export interface ForwardingMessage {
  id: string;
  status: InboundMessageStatus;
  /** Reason code for rejected/failed rows: unknown_sender, rate_limited, too_large, storage_unavailable, job_failed, queue_unavailable, gmail_confirmation, … */
  reason: string | null;
  receivedAt: string;
  completedAt: string | null;
  /** Set for `done` and `over_cap`: link to /verdicts/<id>. */
  verdictId: string | null;
}

export interface ForwardingSettings {
  /** Full address, or null when NEO_INBOUND_DOMAIN is not configured. */
  address: string | null;
  localPart: string;
  /** Forwarding works end to end on this deployment (or MOCK_MODE). */
  configured: boolean;
  /** Member emails whose forwards are accepted (exact match). */
  acceptedSenders: string[];
  /** Only the household owner can rotate. */
  canRotate: boolean;
  /** Latest Gmail forwarding-confirmation code (owner only, last 7 days). The link is never shown. */
  gmailConfirmation: { code: string; receivedAt: string } | null;
  /** Last 20 inbound messages, newest first. */
  messages: ForwardingMessage[];
}

/** POST /api/settings/forwarding body. */
export interface ForwardingRotateRequest {
  action: "rotate";
}
