/**
 * ─── STUB: REPLACE IN INTEGRATION PASS ───────────────────────────────
 * GET    /api/conversations          → { conversations: ConversationSummary[] }
 * DELETE /api/conversations?id=<id>  → 204
 *
 * Backed by the in-memory store in lib/server/conversation-store.ts. The
 * integration pass only swaps getConversationStore() for the @neo/db
 * implementation; this handler's HTTP contract stays the same.
 * ─────────────────────────────────────────────────────────────────────
 */
import type { ConversationListResponse } from "@/lib/api-types";
import { CONVERSATION_ID_RE, getConversationStore } from "@/lib/server/conversation-store";
import { jsonError } from "@/lib/server/http";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const session = await getSession();
  if (!session) return jsonError(401, "Sign in to continue.", "unauthenticated");
  const rows = await getConversationStore().list(session.tenantId, session.userId);
  const body: ConversationListResponse = {
    conversations: rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updatedAt.toISOString() })),
  };
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(req: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return jsonError(401, "Sign in to continue.", "unauthenticated");
  const id = new URL(req.url).searchParams.get("id");
  if (!id || !CONVERSATION_ID_RE.test(id)) return jsonError(400, "Invalid conversation id.", "bad_request");
  const store = getConversationStore();
  if (!(await store.get(id, session.tenantId))) return jsonError(404, "Conversation not found.", "not_found");
  await store.delete(id, session.tenantId);
  return new Response(null, { status: 204 });
}
