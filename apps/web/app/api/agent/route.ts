/**
 * ─── STUB: REPLACE IN INTEGRATION PASS ───────────────────────────────
 * POST /api/agent — streams AgentEvents as NDJSON.
 *
 * HTTP contract to preserve (lib/agent-client.ts depends on it):
 *   request   { conversationId?: string; message: string }   (AgentRequestBody)
 *   200       body: NDJSON AgentEvent lines; header x-conversation-id: <uuid>
 *   400/401/404/503  JSON { error, code? }
 *
 * The integration pass replaces the MOCK_MODE branch with the order in
 * docs/contracts.md: auth → usage.checkCaps (429) → scanUserInput →
 * load conversation → runAgentLoop(createToolRegistry([checkUrlTool]))
 * → appendTurn + usage.recordCheck. The agent must emit verdicts as a
 * ```verdict fenced block (see lib/verdict-fence.ts).
 * ─────────────────────────────────────────────────────────────────────
 */
import { CONVERSATION_ID_HEADER, MAX_MESSAGE_CHARS } from "@/lib/api-types";
import { env } from "@/lib/env";
import { CONVERSATION_ID_RE, getConversationStore } from "@/lib/server/conversation-store";
import { jsonError, NDJSON_HEADERS, readJsonObject } from "@/lib/server/http";
import { mockTurnMessages, scriptMockTurn, streamMockEvents } from "@/lib/server/mock-agent";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return jsonError(401, "Sign in to continue.", "unauthenticated");

  const body = await readJsonObject(req);
  if (!body) return jsonError(400, "Invalid JSON body.", "bad_request");
  const { message, conversationId } = body;
  if (typeof message !== "string" || !message.trim()) return jsonError(400, "Message is required.", "bad_request");
  if (message.length > MAX_MESSAGE_CHARS) {
    return jsonError(400, `Message is too long (max ${MAX_MESSAGE_CHARS} characters).`, "message_too_long");
  }
  if (conversationId !== undefined && (typeof conversationId !== "string" || !CONVERSATION_ID_RE.test(conversationId))) {
    return jsonError(400, "Invalid conversation id.", "bad_request");
  }

  const e = env();
  if (!e.MOCK_MODE) {
    return jsonError(503, "Neo's agent isn't connected yet. Set MOCK_MODE=true to try the demo.", "agent_unavailable");
  }

  const store = getConversationStore();
  let id: string;
  if (conversationId) {
    const existing = await store.get(conversationId, session.tenantId);
    if (!existing) return jsonError(404, "Conversation not found.", "not_found");
    id = existing.id;
  } else {
    id = (await store.create({ tenantId: session.tenantId, userId: session.userId })).id;
  }

  const turn = scriptMockTurn(message);
  const stream = streamMockEvents(turn.events, {
    delayMs: e.MOCK_STREAM_DELAY_MS,
    signal: req.signal,
    onComplete: async (aborted) => {
      await store.appendTurn(id, session.tenantId, {
        messages: aborted ? [{ role: "user", content: message }] : mockTurnMessages(message, turn),
        pendingConfirmation: aborted ? null : (turn.pendingConfirmation ?? null),
      });
    },
  });

  return new Response(stream, { headers: { ...NDJSON_HEADERS, [CONVERSATION_ID_HEADER]: id } });
}
