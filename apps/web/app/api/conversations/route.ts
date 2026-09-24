/**
 * GET    /api/conversations          → { conversations: ConversationSummary[] }  (this user's, in this tenant)
 * DELETE /api/conversations?id=<id>  → 204; 404 for unknown ids and other tenants' conversations
 */
import type { ConversationListResponse } from "@/lib/api-types";
import { CONVERSATION_ID_RE, getConversationStore } from "@/lib/server/conversation-store";
import { jsonError } from "@/lib/server/http";
import { requireApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const { session, response } = await requireApiSession();
  if (!session) return response;
  const rows = await getConversationStore().list(session.tenantId, session.userId);
  const body: ConversationListResponse = {
    conversations: rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updatedAt.toISOString() })),
  };
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(req: Request): Promise<Response> {
  const { session, response } = await requireApiSession();
  if (!session) return response;
  const id = new URL(req.url).searchParams.get("id");
  if (!id || !CONVERSATION_ID_RE.test(id)) return jsonError(400, "Invalid conversation id.", "bad_request");
  const store = getConversationStore();
  if (!(await store.get(id, session.tenantId))) return jsonError(404, "Conversation not found.", "not_found");
  await store.delete(id, session.tenantId);
  return new Response(null, { status: 204 });
}
