/**
 * Wire types shared by the browser client (lib/agent-client.ts) and the
 * API route handlers. These are the HTTP contract of apps/web and stay
 * stable across the integration pass.
 */

/** POST /api/agent body. Omit conversationId to start a new conversation. */
export interface AgentRequestBody {
  conversationId?: string;
  message: string;
}

/** POST /api/agent/confirm body. `id` is the confirmation_required event id. */
export interface ConfirmRequestBody {
  conversationId: string;
  id: string;
  approved: boolean;
}

/**
 * Response header on /api/agent carrying the (possibly newly created)
 * conversation id. The NDJSON body itself is pure AgentEvents.
 */
export const CONVERSATION_ID_HEADER = "x-conversation-id";

/** Max user message length accepted by /api/agent. */
export const MAX_MESSAGE_CHARS = 20_000;

/** GET /api/conversations item. `updatedAt` is ISO-8601. */
export interface ConversationSummary {
  id: string;
  title: string | null;
  updatedAt: string;
}

export interface ConversationListResponse {
  conversations: ConversationSummary[];
}

/** Error body for non-2xx JSON responses. */
export interface ApiError {
  error: string;
  code?: string;
}
