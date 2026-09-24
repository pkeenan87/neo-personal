/**
 * Server-side data loaders for the /chat pages. Everything goes through
 * getConversationStore(), so the integration pass only swaps the store.
 */
import type { ConversationSummary } from "@/lib/api-types";
import { messagesFromStored, type ChatMessage } from "@/lib/chat-state";
import type { NeoSession } from "@/lib/session";
import { CONVERSATION_ID_RE, getConversationStore, toPendingConfirmation } from "./conversation-store";

export async function loadConversationList(session: NeoSession): Promise<ConversationSummary[]> {
  try {
    const rows = await getConversationStore().list(session.tenantId, session.userId);
    return rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updatedAt.toISOString() }));
  } catch (err) {
    console.error("[chat] list conversations failed", err);
    return [];
  }
}

/** Returns null when the id is malformed or not visible to this tenant. */
export async function loadConversation(session: NeoSession, id: string): Promise<{ id: string; messages: ChatMessage[] } | null> {
  if (!CONVERSATION_ID_RE.test(id)) return null;
  const conv = await getConversationStore().get(id, session.tenantId);
  if (!conv) return null;
  return {
    id: conv.id,
    messages: messagesFromStored(conv.messages, { pending: toPendingConfirmation(conv.pendingConfirmation) }),
  };
}
