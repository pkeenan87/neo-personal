/**
 * Conversation persistence. `getConversationStore()` returns the Postgres store
 * from @neo/db (`createConversationStore`) when DATABASE_URL is set, and the
 * in-memory no-database fallback otherwise (MOCK_MODE with zero
 * infrastructure, and the test suite). Both implement @neo/core's
 * ConversationStore and scope every read and write by tenantId.
 */
import type { ConversationStore, MessageParam } from "@neo/core";
import { createConversationStore } from "@neo/db";
import type { StoredPendingConfirmation } from "@/lib/chat-state";
import { getDb } from "./db";

interface Row {
  id: string;
  tenantId: string;
  userId: string;
  title: string | null;
  messages: MessageParam[];
  pendingConfirmation?: unknown;
  updatedAt: Date;
}

/**
 * No-database fallback store: per-process, lost on restart, kept on globalThis
 * so it survives dev hot reloads. Never used when DATABASE_URL is set.
 */
export function createInMemoryConversationStore(): ConversationStore {
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
        messages: structuredClone(r.messages),
        ...(r.pendingConfirmation != null ? { pendingConfirmation: r.pendingConfirmation } : {}),
      };
    },
    async appendTurn(id, tenantId, turn) {
      const r = rows.get(id);
      if (!r || r.tenantId !== tenantId) throw new Error("conversation not found");
      r.messages.push(...structuredClone(turn.messages));
      if (turn.pendingConfirmation !== undefined) r.pendingConfirmation = turn.pendingConfirmation ?? undefined;
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

const g = globalThis as typeof globalThis & {
  __neoMemoryConversationStore?: ConversationStore;
  __neoDbConversationStore?: { db: unknown; store: ConversationStore };
};

export function getConversationStore(): ConversationStore {
  const db = getDb();
  if (db) {
    if (g.__neoDbConversationStore?.db !== db) g.__neoDbConversationStore = { db, store: createConversationStore(db) };
    return g.__neoDbConversationStore.store;
  }
  g.__neoMemoryConversationStore ??= createInMemoryConversationStore();
  return g.__neoMemoryConversationStore;
}

/** Conversation titles come from the first user message (the store's create() takes the title). */
export function titleFromMessage(message: string): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 79)}…` : oneLine;
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
