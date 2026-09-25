/**
 * Server-added context blocks inside a user message (e.g. the stored verdict
 * behind "Ask Neo about this"). The model sees them; the chat UI hides them
 * when rebuilding history (lib/chat-state.ts). Client-safe.
 */
export const HIDDEN_CONTEXT_PREFIX = "[neo:context]";

export function isHiddenContextText(text: string): boolean {
  return text.startsWith(HIDDEN_CONTEXT_PREFIX);
}
