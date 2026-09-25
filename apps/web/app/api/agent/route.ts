/**
 * POST /api/agent — run one agent turn and stream AgentEvents as NDJSON.
 *
 *   request   { conversationId?: string; message: string; attachments?: { id }[]; playbook?: PlaybookId; verdictId?: string }   (AgentRequestBody)
 *             message may be empty when attachments are given; attachments ≤ 5
 *             playbook → this turn runs with effort "high" (also the turn after a reply that declared a playbook);
 *             verdictId → the stored verdict (loaded here, tenant + role scoped; 404 if not visible) is appended
 *             to the user message as a hidden, trust-boundary-wrapped context block
 *   200       NDJSON AgentEvent lines; header x-conversation-id: <uuid>
 *   400       invalid body, or input blocked by the injection guard (code "input_blocked")
 *   401       no session
 *   404       unknown conversation (or another tenant's); an attachment that is missing, expired or another tenant's
 *   409       the conversation is waiting on a confirmation (code "confirmation_pending")
 *   429       usage cap: { error: "usage_cap_exceeded", reason, limit, resetAt, message } + Retry-After
 *   503       usage store unavailable (fail closed), storage unavailable (incl. artifacts), or no model configured
 *
 * Order (docs/contracts.md, _specs/usage-caps.md): auth → validate →
 * usage.checkCaps → scanUserInput/shouldBlock → load/create conversation →
 * runAgentLoop → appendTurn + usage.recordCheck (+ verdict row), always.
 */
import { hashPii, logger, runAgentLoop, scanUserInput, shouldBlock, wrapToolResult, type MessageParam } from "@neo/core";
import { CONVERSATION_ID_HEADER, MAX_MESSAGE_CHARS } from "@/lib/api-types";
import { ATTACHMENT_LIMITS, parseAttachmentNote } from "@/lib/attachments";
import { env } from "@/lib/env";
import { agentEffort, streamAgentRun } from "@/lib/server/agent-run";
// --- dashboard + incident playbooks (agent E) ---
import { HIDDEN_CONTEXT_PREFIX } from "@/lib/hidden-context";
import { isPlaybookId } from "@/lib/playbooks";
import { getVisibleVerdict, VERDICT_ID_RE, verdictBody } from "@/lib/server/verdict-data";
// --- end dashboard + incident playbooks ---
import { CONVERSATION_ID_RE, getConversationStore, titleFromMessage, toPendingConfirmation } from "@/lib/server/conversation-store";
import { buildUserContent, defaultAttachmentPrompt, getArtifactStore, type ArtifactMeta } from "@/lib/server/artifacts";
import { jsonError, readJsonObject } from "@/lib/server/http";
import { capExceededResponse, checkCaps, noteCapHit, type CapCheckResult } from "@/lib/server/usage";
import { requireApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request): Promise<Response> {
  const { session, response } = await requireApiSession();
  if (!session) return response;

  const body = await readJsonObject(req);
  if (!body) return jsonError(400, "Invalid JSON body.", "bad_request");
  const { message, conversationId } = body;
  // ── Phase 1: intake attachments ──
  const attachmentIds = parseAttachmentIds(body.attachments);
  if (attachmentIds === null) {
    return jsonError(400, `Attachments must be a list of at most ${ATTACHMENT_LIMITS.perMessage} { id } objects.`, "bad_request");
  }
  if (typeof message !== "string" || (!message.trim() && attachmentIds.length === 0)) {
    return jsonError(400, "Message is required.", "bad_request");
  }
  // ── end Phase 1: intake attachments ──
  if (message.length > MAX_MESSAGE_CHARS) {
    return jsonError(400, `Message is too long (max ${MAX_MESSAGE_CHARS} characters).`, "message_too_long");
  }
  if (conversationId !== undefined && (typeof conversationId !== "string" || !CONVERSATION_ID_RE.test(conversationId))) {
    return jsonError(400, "Invalid conversation id.", "bad_request");
  }

  // --- dashboard + incident playbooks (agent E) ---
  const { playbook, verdictId } = body;
  if (playbook !== undefined && !isPlaybookId(playbook)) return jsonError(400, "Unknown playbook.", "bad_request");
  if (verdictId !== undefined && (typeof verdictId !== "string" || !VERDICT_ID_RE.test(verdictId))) {
    return jsonError(400, "Invalid verdict id.", "bad_request");
  }
  let verdictContext: string | undefined;
  if (typeof verdictId === "string") {
    const row = await getVisibleVerdict(session, verdictId).catch(() => undefined);
    const verdict = row ? verdictBody(row) : null;
    if (!row || !verdict) return jsonError(404, "Verdict not found.", "not_found");
    // Loaded from the database, never from the client; its evidence came from
    // attacker-controlled content, so it enters the model wrapped.
    verdictContext = `${HIDDEN_CONTEXT_PREFIX} The user is asking about this stored Neo verdict (checked ${row.createdAt.toISOString().slice(0, 10)}):\n${wrapToolResult(
      "stored_verdict",
      { verdict_id: row.id, source: row.source, verdict },
      conversationId ? { conversationId } : {},
    )}`;
  }
  // --- end dashboard + incident playbooks ---

  const e = env();
  if (!e.MOCK_MODE && !e.HAS_ANTHROPIC_CREDENTIALS) {
    return jsonError(503, "Neo's AI model isn't configured on this server. Set ANTHROPIC_API_KEY, or MOCK_MODE=true for the demo.", "agent_unavailable");
  }

  // Usage caps: fail closed if the usage store is unavailable.
  let caps: CapCheckResult;
  try {
    caps = await checkCaps(session.tenantId);
  } catch (err) {
    logger.error("Usage cap check failed", "api.agent", {
      tenantId: session.tenantId,
      errorMessage: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
    });
    return jsonError(503, "Neo can't check your usage right now. Please try again in a moment.", "usage_unavailable");
  }
  if (!caps.allowed && caps.reason) {
    await noteCapHit(session.tenantId, session.userId, caps, caps.reason);
    return capExceededResponse(caps, caps.reason);
  }

  // Prompt-injection guard on what the user typed (monitor logs; block rejects).
  const scan = scanUserInput(message, conversationId ? { conversationId } : {});
  if (shouldBlock(scan)) {
    return jsonError(
      400,
      "That message looks like an attempt to override Neo's instructions, so it wasn't sent. If you're asking about a suspicious message, paste it and ask Neo to check it.",
      "input_blocked",
    );
  }

  // ── Phase 1: intake attachments (tenant-scoped; 404 for missing, expired or foreign ids) ──
  let userContent: MessageParam["content"] = message;
  if (attachmentIds.length > 0) {
    const artifacts = getArtifactStore();
    if (!artifacts) return jsonError(503, "File uploads aren't configured on this server.", "storage_unavailable");
    try {
      const metas = await Promise.all(attachmentIds.map((a) => artifacts.get(a, session.tenantId)));
      const found = metas.filter((m): m is ArtifactMeta => m !== undefined);
      const blocks =
        found.length === metas.length
          ? await buildUserContent(message.trim() ? message : defaultAttachmentPrompt(found), found, artifacts, session.tenantId)
          : null;
      if (!blocks) return jsonError(404, "An attached file wasn't found. It may have expired; please attach it again.", "not_found");
      userContent = blocks;
    } catch (err) {
      logger.error("Attachment load failed", "api.agent", {
        tenantId: session.tenantId,
        userIdHash: hashPii(session.userId),
        errorMessage: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
      });
      return jsonError(503, "Neo can't reach its storage right now. Please try again in a moment.", "storage_unavailable");
    }
  }
  // ── end Phase 1: intake attachments ──

  const store = getConversationStore();
  let id: string;
  let history: MessageParam[];
  try {
    if (conversationId) {
      const existing = await store.get(conversationId, session.tenantId);
      if (!existing) return jsonError(404, "Conversation not found.", "not_found");
      if (toPendingConfirmation(existing.pendingConfirmation)) {
        return jsonError(409, "Approve or decline the pending action first.", "confirmation_pending");
      }
      id = existing.id;
      history = existing.messages;
    } else {
      id = (await store.create({ tenantId: session.tenantId, userId: session.userId, title: titleFromMessage(message.trim() ? message : attachmentTitle(userContent)) })).id;
      history = [];
    }
  } catch (err) {
    logger.error("Conversation load failed", "api.agent", {
      tenantId: session.tenantId,
      userIdHash: hashPii(session.userId),
      errorMessage: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
    });
    return jsonError(503, "Neo can't reach its storage right now. Please try again in a moment.", "storage_unavailable");
  }

  // Hidden verdict context goes after the user's text and any attachment blocks.
  const userMessage: MessageParam = verdictContext
    ? {
        role: "user",
        content: [
          ...(typeof userContent === "string" ? [{ type: "text" as const, text: userContent }] : userContent),
          { type: "text" as const, text: verdictContext },
        ],
      }
    : { role: "user", content: userContent };
  return streamAgentRun({
    session,
    conversationId: id,
    prefix: [userMessage],
    kind: "check",
    signal: req.signal,
    headers: { [CONVERSATION_ID_HEADER]: id },
    effort: agentEffort({ ...(playbook ? { playbook } : {}), history }),
    run: (common) => runAgentLoop({ ...common, messages: [...history, userMessage] }),
  });
}

// ── Phase 1: intake attachments ──
const ATTACHMENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `attachments` from the body: [] when absent, null when malformed. Ids are de-duplicated. */
function parseAttachmentIds(v: unknown): string[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > ATTACHMENT_LIMITS.perMessage) return null;
  const ids: string[] = [];
  for (const a of v) {
    const id = typeof a === "object" && a !== null ? (a as { id?: unknown }).id : undefined;
    if (typeof id !== "string" || !ATTACHMENT_ID_RE.test(id)) return null;
    if (!ids.includes(id.toLowerCase())) ids.push(id.toLowerCase());
  }
  return ids;
}

/** Conversation title when the user sent only attachments: the first file name. */
function attachmentTitle(content: MessageParam["content"]): string {
  if (typeof content === "string") return content;
  for (const b of content) {
    const ref = b.type === "text" ? parseAttachmentNote(b.text) : null;
    if (ref) return ref.filename;
  }
  return "Attachment";
}
// ── end Phase 1: intake attachments ──
