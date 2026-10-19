/** Outlook.com connector types (_specs/outlook-connector.md). Every Graph value is attacker-controlled data. */
import type { OutlookConnectorStatus } from "@neo/db";

export type { OutlookConnectorStatus };
export const OUTLOOK_FORWARDING_ALERT_KIND = "mailbox_forwarding" as const;

export type GraphMe = {
  /** Stable Microsoft account id (the address is only a label). */
  id: string;
  displayAddress: string;
  /** The user's own addresses and aliases as Graph reports them (mail, userPrincipalName, otherMails). */
  addresses: string[];
};
export type GraphRecipient = { address?: string | undefined };
export type GraphRule = {
  id: string;
  enabled: boolean;
  forwardTo: GraphRecipient[];
  redirectTo: GraphRecipient[];
  forwardAsAttachmentTo: GraphRecipient[];
};
export type GraphRulePage = { rules: GraphRule[]; nextLink?: string | undefined };
export type GraphDeltaMessage = { id: string; fromAddress?: string | undefined; removed?: boolean | undefined };
/** One delta page: `nextLink` while more pages remain, `deltaLink` on the last one. Both are opaque and sensitive. */
export type GraphDeltaPage = { messages: GraphDeltaMessage[]; nextLink?: string | undefined; deltaLink?: string | undefined };
export type GraphMessage = {
  id: string;
  /** `internetMessageHeaders`, in message order. */
  headers: { name: string; value: string }[];
  bodyType: "html" | "text";
  body: string;
};

export interface OutlookGraphClient {
  getMe(signal?: AbortSignal): Promise<GraphMe>;
  listInboxRules(nextLink?: string, signal?: AbortSignal): Promise<GraphRulePage>;
  getInboxDelta(input: { nextLink?: string | undefined; deltaLink?: string | undefined; /** First run only: lower bound on receivedDateTime. */ since?: Date | undefined; signal?: AbortSignal | undefined }): Promise<GraphDeltaPage>;
  getCandidateMessage(id: string, signal?: AbortSignal): Promise<GraphMessage>;
}

/** Graph 429. `retryAfterSeconds` is already capped at one hour. */
export class GraphRateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("graph rate limited");
    this.name = "GraphRateLimitError";
  }
}
/** Graph 401/403: the access token was not accepted. */
export class GraphAuthError extends Error {
  constructor() {
    super("graph rejected the access token");
    this.name = "GraphAuthError";
  }
}
export class GraphHttpError extends Error {
  constructor(readonly status: number) {
    super(`graph request failed (${status})`);
    this.name = "GraphHttpError";
  }
}

export type OutlookRunCtx = { tenantId: string; userId: string; connectorId: string };

export const MAX_RETRY_AFTER_SECONDS = 60 * 60;
