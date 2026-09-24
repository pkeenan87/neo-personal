/**
 * ─── STUB: REPLACE IN INTEGRATION PASS ───────────────────────────────
 * In-memory ConversationStore for mock/dev mode. Mirrors the
 * `ConversationStore` interface in docs/contracts.md (@neo/core) so the
 * integration pass replaces `getConversationStore()` with
 *
 *   createConversationStore(createDb())   // from @neo/db
 *
 * and deletes the in-memory implementation. Data lives on globalThis so it
 * survives dev hot reloads; it is per-process and lost on restart.
 * ─────────────────────────────────────────────────────────────────────
 */
import type { StoredMessage, StoredPendingConfirmation } from "@/lib/chat-state";

/** TEMPORARY mirror of @neo/core ConversationStore (MessageParam narrowed to StoredMessage). */
export interface ConversationStore {
  create(input: { tenantId: string; userId: string; title?: string }): Promise<{ id: string }>;
  get(
    id: string,
    tenantId: string,
  ): Promise<{ id: string; messages: StoredMessage[]; pendingConfirmation?: unknown } | undefined>;
  appendTurn(
    id: string,
    tenantId: string,
    turn: {
      messages: StoredMessage[];
      usage?: { input_tokens: number; output_tokens: number };
      pendingConfirmation?: unknown | null;
    },
  ): Promise<void>;
  list(tenantId: string, userId: string): Promise<Array<{ id: string; title: string | null; updatedAt: Date }>>;
  delete(id: string, tenantId: string): Promise<void>;
}

interface Row {
  id: string;
  tenantId: string;
  userId: string;
  title: string | null;
  messages: StoredMessage[];
  pendingConfirmation?: unknown;
  updatedAt: Date;
}

function createMemoryStore(): ConversationStore {
  const rows = new Map<string, Row>();
  return {
    async create({ tenantId, userId, title }) {
      const id = crypto.randomUUID();
      rows.set(id, { id, tenantId, userId, title: title ?? null, messages: [], updatedAt: new Date() });
      return { id };
    },
    async get(id, tenantId) {
      const r = rows.get(id);
      if (!r || r.tenantId !== tenantId) return undefined;
      return {
        id: r.id,
        messages: [...r.messages],
        ...(r.pendingConfirmation ? { pendingConfirmation: r.pendingConfirmation } : {}),
      };
    },
    async appendTurn(id, tenantId, turn) {
      const r = rows.get(id);
      if (!r || r.tenantId !== tenantId) throw new Error("conversation not found");
      r.messages.push(...turn.messages);
      if (turn.pendingConfirmation !== undefined) r.pendingConfirmation = turn.pendingConfirmation ?? undefined;
      if (!r.title) {
        const firstUser = r.messages.find((m) => m.role === "user" && typeof m.content === "string");
        if (firstUser && typeof firstUser.content === "string") r.title = firstUser.content.slice(0, 80);
      }
      r.updatedAt = new Date();
    },
    async list(tenantId, userId) {
      return [...rows.values()]
        .filter((r) => r.tenantId === tenantId && r.userId === userId)
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .map((r) => ({ id: r.id, title: r.title, updatedAt: r.updatedAt }));
    },
    async delete(id, tenantId) {
      const r = rows.get(id);
      if (r && r.tenantId === tenantId) rows.delete(id);
    },
  };
}

const g = globalThis as typeof globalThis & { __neoMemoryConversationStore?: ConversationStore };

export function getConversationStore(): ConversationStore {
  g.__neoMemoryConversationStore ??= createMemoryStore();
  return g.__neoMemoryConversationStore;
}

/** Narrow an opaque persisted pendingConfirmation to what the UI needs. */
export function toPendingConfirmation(v: unknown): StoredPendingConfirmation | null {
  if (typeof v !== "object" || v === null) return null;
  const p = v as Record<string, unknown>;
  if (typeof p.id !== "string" || typeof p.name !== "string") return null;
  return {
    id: p.id,
    name: p.name,
    input: p.input,
    ...(typeof p.description === "string" ? { description: p.description } : {}),
  };
}

/** Conversation ids are UUIDs (Postgres uuid in @neo/db). */
export const CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
