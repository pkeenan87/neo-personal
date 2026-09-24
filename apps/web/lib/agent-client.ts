/**
 * Browser client for the apps/web HTTP API. This is the seam the chat UI
 * (and later the mobile/desktop wrappers) talk through; it is NOT a stub
 * and should survive the integration pass unchanged.
 */
import type { AgentEvent } from "@/types/agent-event";
import {
  CONVERSATION_ID_HEADER,
  type AgentRequestBody,
  type ConfirmRequestBody,
  type ConversationListResponse,
  type ConversationSummary,
} from "./api-types";
import { readAgentEvents } from "./ndjson";

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function errorFrom(res: Response): Promise<ApiRequestError> {
  let message = `Request failed (${res.status})`;
  let code: string | undefined;
  try {
    const body: unknown = await res.json();
    if (typeof body === "object" && body !== null) {
      const b = body as { error?: unknown; code?: unknown };
      if (typeof b.error === "string") message = b.error;
      if (typeof b.code === "string") code = b.code;
    }
  } catch {
    // non-JSON error body
  }
  return new ApiRequestError(message, res.status, code);
}

export interface StreamAgentOptions {
  conversationId?: string | null;
  message: string;
  signal?: AbortSignal;
  onEvent: (e: AgentEvent) => void;
  /** Called as soon as response headers arrive, before any events. */
  onConversationId?: (id: string) => void;
}

export interface StreamResult {
  conversationId: string | null;
}

async function consume(res: Response, onEvent: (e: AgentEvent) => void): Promise<void> {
  if (!res.body) return;
  for await (const e of readAgentEvents(res.body)) onEvent(e);
}

/**
 * POST /api/agent and dispatch each NDJSON AgentEvent to `onEvent`.
 * Resolves when the stream ends. Rejects with ApiRequestError on a non-2xx
 * response and with an AbortError when `signal` aborts.
 */
export async function streamAgent({
  conversationId,
  message,
  signal,
  onEvent,
  onConversationId,
}: StreamAgentOptions): Promise<StreamResult> {
  const body: AgentRequestBody = { message, ...(conversationId ? { conversationId } : {}) };
  const res = await fetch("/api/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await errorFrom(res);
  const id = res.headers.get(CONVERSATION_ID_HEADER) ?? conversationId ?? null;
  if (id && onConversationId) onConversationId(id);
  await consume(res, onEvent);
  return { conversationId: id };
}

export interface ConfirmActionOptions {
  conversationId: string;
  /** The `id` of the confirmation_required event. */
  id: string;
  approved: boolean;
  signal?: AbortSignal;
  /** The confirm route streams the resumed agent turn as NDJSON. */
  onEvent?: (e: AgentEvent) => void;
}

/** POST /api/agent/confirm and stream the resumed turn. */
export async function confirmAction({
  conversationId,
  id,
  approved,
  signal,
  onEvent,
}: ConfirmActionOptions): Promise<void> {
  const body: ConfirmRequestBody = { conversationId, id, approved };
  const res = await fetch("/api/agent/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await errorFrom(res);
  await consume(res, onEvent ?? (() => {}));
}

/** GET /api/conversations */
export async function listConversations(signal?: AbortSignal): Promise<ConversationSummary[]> {
  const res = await fetch("/api/conversations", { signal, cache: "no-store" });
  if (!res.ok) throw await errorFrom(res);
  const data = (await res.json()) as ConversationListResponse;
  return Array.isArray(data.conversations) ? data.conversations : [];
}

/** DELETE /api/conversations?id=… */
export async function deleteConversation(id: string): Promise<void> {
  const res = await fetch(`/api/conversations?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw await errorFrom(res);
}
