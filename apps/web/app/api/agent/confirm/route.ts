/**
 * ─── STUB: REPLACE IN INTEGRATION PASS ───────────────────────────────
 * POST /api/agent/confirm — approve/decline a pending destructive tool
 * call and stream the resumed turn as NDJSON AgentEvents.
 *
 * HTTP contract to preserve (lib/agent-client.ts confirmAction):
 *   request   { conversationId: string; id: string; approved: boolean }
 *   200       body: NDJSON AgentEvent lines
 *   400/401/404/409/503  JSON { error, code? }   (409 = nothing pending / id mismatch)
 *
 * The integration pass replaces the MOCK_MODE branch with
 * resumeAfterConfirmation() from @neo/core, loading `pending` from the
 * ConversationStore and persisting the result with appendTurn.
 * ─────────────────────────────────────────────────────────────────────
 */
import { env } from "@/lib/env";
import { CONVERSATION_ID_RE, getConversationStore, toPendingConfirmation } from "@/lib/server/conversation-store";
import { jsonError, NDJSON_HEADERS, readJsonObject } from "@/lib/server/http";
import { mockTurnMessages, scriptMockConfirmation, streamMockEvents } from "@/lib/server/mock-agent";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return jsonError(401, "Sign in to continue.", "unauthenticated");

  const body = await readJsonObject(req);
  if (!body) return jsonError(400, "Invalid JSON body.", "bad_request");
  const { conversationId, id, approved } = body;
  if (typeof conversationId !== "string" || !CONVERSATION_ID_RE.test(conversationId)) {
    return jsonError(400, "Invalid conversation id.", "bad_request");
  }
  if (typeof id !== "string" || !id || typeof approved !== "boolean") {
    return jsonError(400, "Expected { conversationId, id, approved }.", "bad_request");
  }

  const e = env();
  if (!e.MOCK_MODE) {
    return jsonError(503, "Neo's agent isn't connected yet.", "agent_unavailable");
  }

  const store = getConversationStore();
  const conv = await store.get(conversationId, session.tenantId);
  if (!conv) return jsonError(404, "Conversation not found.", "not_found");
  const pending = toPendingConfirmation(conv.pendingConfirmation);
  if (!pending || pending.id !== id) {
    return jsonError(409, "There is no pending action with that id.", "no_pending_confirmation");
  }

  // Clear first so a double-submit gets 409 rather than running twice.
  await store.appendTurn(conversationId, session.tenantId, { messages: [], pendingConfirmation: null });

  const turn = scriptMockConfirmation(approved, pending);
  const stream = streamMockEvents(turn.events, {
    delayMs: e.MOCK_STREAM_DELAY_MS,
    signal: req.signal,
    onComplete: async (aborted) => {
      if (!aborted) await store.appendTurn(conversationId, session.tenantId, { messages: mockTurnMessages(null, turn) });
    },
  });
  return new Response(stream, { headers: NDJSON_HEADERS });
}
