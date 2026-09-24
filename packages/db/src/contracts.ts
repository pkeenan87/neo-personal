// TEMPORARY mirror of @neo/core types; integration replaces this with import type from "@neo/core"
// Copied verbatim from docs/contracts.md (@neo/core → "Persistence interface (implemented by @neo/db)").
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";

export type { MessageParam };

export interface ConversationStore {
  create(input: { tenantId: string; userId: string; title?: string }): Promise<{ id: string }>;
  get(id: string, tenantId: string): Promise<{ id: string; messages: MessageParam[]; pendingConfirmation?: unknown } | undefined>;
  appendTurn(id: string, tenantId: string, turn: { messages: MessageParam[]; usage?: { input_tokens: number; output_tokens: number }; pendingConfirmation?: unknown | null }): Promise<void>;
  list(tenantId: string, userId: string): Promise<Array<{ id: string; title: string | null; updatedAt: Date }>>;
  delete(id: string, tenantId: string): Promise<void>;
}
