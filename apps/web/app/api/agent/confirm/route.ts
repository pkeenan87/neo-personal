/**
 * POST /api/agent/confirm — approve or decline the pending destructive tool
 * call and stream the resumed turn as NDJSON AgentEvents.
 *
 *   request   { conversationId: string; id: string; approved: boolean }
 *   200       NDJSON AgentEvent lines
 *   400/401/404  JSON { error, code? }
 *   409       nothing pending, or the id does not match (code "no_pending_confirmation")
 *   429       daily token cap reached (approving only; declining is always allowed)
 *   503       usage store unavailable while approving (fail closed)
 *
 * A resume is not a new check: only the daily token cap applies, and usage is
 * recorded with kind "resume" (_specs/usage-caps.md).
 */
import { logger, resumeAfterConfirmation } from "@neo/core";
import { streamAgentRun } from "@/lib/server/agent-run";
import { CONVERSATION_ID_RE, getConversationStore, toPendingConfirmation } from "@/lib/server/conversation-store";
import { jsonError, readJsonObject } from "@/lib/server/http";
import { capExceededResponse, checkCaps, noteCapHit } from "@/lib/server/usage";
import { requireApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request): Promise<Response> {
  const { session, response } = await requireApiSession();
  if (!session) return response;

  const body = await readJsonObject(req);
  if (!body) return jsonError(400, "Invalid JSON body.", "bad_request");
  const { conversationId, id, approved } = body;
  if (typeof conversationId !== "string" || !CONVERSATION_ID_RE.test(conversationId)) {
    return jsonError(400, "Invalid conversation id.", "bad_request");
  }
  if (typeof id !== "string" || !id || typeof approved !== "boolean") {
    return jsonError(400, "Expected { conversationId, id, approved }.", "bad_request");
  }

  const store = getConversationStore();
  const conv = await store.get(conversationId, session.tenantId);
  if (!conv) return jsonError(404, "Conversation not found.", "not_found");
  const pending = toPendingConfirmation(conv.pendingConfirmation);
  if (!pending || pending.id !== id) {
    return jsonError(409, "There is no pending action with that id.", "no_pending_confirmation");
  }

  if (approved) {
    try {
      const caps = await checkCaps(session.tenantId);
      if (!caps.allowed && caps.reason === "daily_tokens") {
        await noteCapHit(session.tenantId, session.userId, caps, "daily_tokens");
        return capExceededResponse(caps, "daily_tokens");
      }
    } catch (err) {
      logger.error("Usage cap check failed", "api.agent.confirm", {
        tenantId: session.tenantId,
        errorMessage: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
      });
      return jsonError(503, "Neo can't check your usage right now. Please try again in a moment.", "usage_unavailable");
    }
  }

  // Clear first so a double-submit gets 409 rather than running the action twice.
  await store.appendTurn(conversationId, session.tenantId, { messages: [], pendingConfirmation: null });

  return streamAgentRun({
    session,
    conversationId,
    prefix: [],
    kind: "resume",
    signal: req.signal,
    run: (common) =>
      resumeAfterConfirmation({
        ...common,
        messages: conv.messages,
        approved,
        pending: { id: pending.id, name: pending.name, input: pending.input },
      }),
  });
}
