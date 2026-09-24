import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import type { Db } from "./client.js";
import type { ConversationStore, MessageParam } from "./contracts.js";
import { conversations, turns } from "./schema/index.js";
import { tenantScoped } from "./tenant.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Postgres implementation of @neo/core's ConversationStore. All access is tenant-scoped. */
export function createConversationStore(db: Db): ConversationStore {
  return {
    async create({ tenantId, userId, title }) {
      const [row] = await tenantScoped(db, tenantId).insert(conversations, { userId, title: title ?? null });
      if (!row) throw new Error("@neo/db: conversation insert returned no row");
      return { id: row.id };
    },

    async get(id, tenantId) {
      if (!UUID_RE.test(id)) return undefined;
      return tenantScoped(db, tenantId).transaction(async (t) => {
        const convo = await t.first(conversations, eq(conversations.id, id));
        if (!convo) return undefined;
        const rows = await t.tx
          .select({ messages: turns.messages })
          .from(turns)
          .where(and(eq(turns.tenantId, tenantId), eq(turns.conversationId, id)))
          .orderBy(asc(turns.seq));
        const messages: MessageParam[] = rows.flatMap((r) => r.messages);
        return convo.pendingConfirmation == null
          ? { id: convo.id, messages }
          : { id: convo.id, messages, pendingConfirmation: convo.pendingConfirmation };
      });
    },

    async appendTurn(id, tenantId, turn) {
      if (!UUID_RE.test(id)) throw new Error("@neo/db: conversation not found");
      await tenantScoped(db, tenantId).transaction(async (t) => {
        // UPDATE takes the conversation's row lock, so concurrent appends to the same
        // conversation serialize here and the max(seq)+1 below is race-free. The unique
        // (conversation_id, seq) index is the backstop.
        const set: { updatedAt: SQL; pendingConfirmation?: unknown } = { updatedAt: sql`now()` };
        if (turn.pendingConfirmation !== undefined) set.pendingConfirmation = turn.pendingConfirmation;
        const updated = await t.update(conversations, set, eq(conversations.id, id));
        if (updated.length === 0) throw new Error("@neo/db: conversation not found");

        await t.tx.insert(turns).values({
          conversationId: id,
          tenantId,
          seq: sql`(select coalesce(max(${turns.seq}), 0) + 1 from ${turns} where ${turns.conversationId} = ${id})`,
          messages: turn.messages,
          usage: turn.usage ?? null,
        });
      });
    },

    async list(tenantId, userId) {
      const rows = await tenantScoped(db, tenantId).select(conversations, eq(conversations.userId, userId), {
        orderBy: [desc(conversations.updatedAt), desc(conversations.id)],
      });
      return rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updatedAt }));
    },

    async delete(id, tenantId) {
      if (!UUID_RE.test(id)) return;
      // turns cascade via FK; verdicts/usage_events keep their rows with conversation_id nulled.
      await tenantScoped(db, tenantId).delete(conversations, eq(conversations.id, id));
    },
  };
}
