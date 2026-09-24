import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConversationStore } from "../src/conversation-store.js";
import type { ConversationStore, MessageParam } from "../src/contracts.js";
import { conversations, turns } from "../src/schema/index.js";
import { tenantScoped } from "../src/tenant.js";
import { createTenantForUser } from "../src/tenants.js";
import { createTestDb, createUser, type TestDb } from "./helpers.js";

const turn1: MessageParam[] = [
  { role: "user", content: "Is https://examp1e.com safe?" },
  { role: "assistant", content: [{ type: "text", text: "Checking." }] },
];
const turn2: MessageParam[] = [
  { role: "user", content: "And now?" },
  { role: "assistant", content: "It looks like a lookalike domain." },
];

describe("createConversationStore", () => {
  let t: TestDb;
  let store: ConversationStore;
  let tenantA: string;
  let userA: string;
  let tenantB: string;
  let userB: string;

  beforeAll(async () => {
    t = await createTestDb();
    store = createConversationStore(t.db);
    userA = await createUser(t.db, "A");
    userB = await createUser(t.db, "B");
    ({ tenantId: tenantA } = await createTenantForUser(t.db, { userId: userA, name: "A" }));
    ({ tenantId: tenantB } = await createTenantForUser(t.db, { userId: userB, name: "B" }));
  });
  afterAll(async () => {
    await t.close();
  });

  it("round-trips create → appendTurn ×2 → get → list → delete", async () => {
    const { id } = await store.create({ tenantId: tenantA, userId: userA, title: "Link check" });
    const [before] = await t.db.select().from(conversations).where(eq(conversations.id, id));

    await store.appendTurn(id, tenantA, { messages: turn1, usage: { input_tokens: 100, output_tokens: 20 } });
    await store.appendTurn(id, tenantA, {
      messages: turn2,
      pendingConfirmation: { id: "toolu_1", name: "block_sender", input: { sender: "x@y.z" } },
    });

    const got = await store.get(id, tenantA);
    expect(got).toEqual({
      id,
      messages: [...turn1, ...turn2],
      pendingConfirmation: { id: "toolu_1", name: "block_sender", input: { sender: "x@y.z" } },
    });

    const seqs = await t.db.select({ seq: turns.seq }).from(turns).where(eq(turns.conversationId, id)).orderBy(turns.seq);
    expect(seqs.map((r) => r.seq)).toEqual([1, 2]);

    const [after] = await t.db.select().from(conversations).where(eq(conversations.id, id));
    expect(after!.updatedAt.getTime()).toBeGreaterThanOrEqual(before!.updatedAt.getTime());

    // null clears the pending confirmation; undefined leaves it untouched.
    await store.appendTurn(id, tenantA, { messages: [{ role: "user", content: "yes" }], pendingConfirmation: null });
    const cleared = await store.get(id, tenantA);
    expect(cleared?.pendingConfirmation).toBeUndefined();
    expect(cleared && "pendingConfirmation" in cleared).toBe(false);
    expect(cleared?.messages).toHaveLength(5);

    const listed = await store.list(tenantA, userA);
    expect(listed.map((c) => c.id)).toContain(id);
    expect(listed.find((c) => c.id === id)).toMatchObject({ title: "Link check", updatedAt: expect.any(Date) });

    await store.delete(id, tenantA);
    expect(await store.get(id, tenantA)).toBeUndefined();
    expect(await t.db.select().from(turns).where(eq(turns.conversationId, id))).toHaveLength(0);
  });

  it("assigns unique consecutive seq numbers under concurrent appends", async () => {
    const { id } = await store.create({ tenantId: tenantA, userId: userA });
    await Promise.all(
      Array.from({ length: 5 }, (_, i) => store.appendTurn(id, tenantA, { messages: [{ role: "user", content: `m${i}` }] })),
    );
    const seqs = await t.db.select({ seq: turns.seq }).from(turns).where(eq(turns.conversationId, id)).orderBy(turns.seq);
    expect(seqs.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it("lists newest first and only the user's own conversations", async () => {
    const other = await createUser(t.db, "A2");
    const c1 = await store.create({ tenantId: tenantA, userId: userA, title: "first" });
    const c2 = await store.create({ tenantId: tenantA, userId: userA, title: "second" });
    await store.create({ tenantId: tenantA, userId: other, title: "someone else" });
    await store.appendTurn(c1.id, tenantA, { messages: turn1 });

    const listed = await store.list(tenantA, userA);
    const ids = listed.map((c) => c.id);
    expect(ids.indexOf(c1.id)).toBeLessThan(ids.indexOf(c2.id));
    expect(listed.every((c) => c.title !== "someone else")).toBe(true);
  });

  it("isolates tenants: tenant B cannot read, append to, list or delete tenant A's conversation", async () => {
    const { id } = await store.create({ tenantId: tenantA, userId: userA, title: "private" });
    await store.appendTurn(id, tenantA, { messages: turn1 });

    expect(await store.get(id, tenantB)).toBeUndefined();
    await expect(store.appendTurn(id, tenantB, { messages: turn2 })).rejects.toThrow(/not found/);
    expect((await store.list(tenantB, userA)).map((c) => c.id)).not.toContain(id);
    expect(await tenantScoped(t.db, tenantB).select(conversations, eq(conversations.id, id))).toEqual([]);

    await store.delete(id, tenantB);
    expect((await store.get(id, tenantA))?.messages).toEqual(turn1);
  });

  it("treats malformed ids as not found", async () => {
    expect(await store.get("not-a-uuid", tenantA)).toBeUndefined();
    await expect(store.appendTurn("not-a-uuid", tenantA, { messages: turn1 })).rejects.toThrow(/not found/);
    await expect(store.delete("not-a-uuid", tenantA)).resolves.toBeUndefined();
  });
});
