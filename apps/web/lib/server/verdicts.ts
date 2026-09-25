/**
 * Pull the ```verdict block out of the agent's final answer and store it as a
 * `verdicts` row (tenant-scoped). The one verdict persistence path for chat and
 * inbound mail. The block is validated with VerdictSchema
 * (via splitVerdictSegments); invalid blocks are ignored here and rendered by
 * the UI as an "invalid verdict" notice.
 */
import { hashPii, logger, type MessageParam } from "@neo/core";
import { saveVerdict as dbSaveVerdict, type VerdictSource } from "@neo/db";
import type { Verdict } from "@neo/verdict";
import { splitVerdictSegments } from "@/lib/verdict-fence";
import { getDb } from "./db";
import { saveMemoryVerdict } from "./memory-state";

/** Text of the last assistant message in `messages` (text blocks joined). */
export function finalAssistantText(messages: readonly MessageParam[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "assistant") continue;
    if (typeof m.content === "string") return m.content;
    return m.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("");
  }
  return "";
}

/** The last valid verdict in the final assistant message, or null. */
export function extractVerdict(messages: readonly MessageParam[]): Verdict | null {
  const segments = splitVerdictSegments(finalAssistantText(messages));
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i];
    if (s?.kind === "verdict") return s.verdict;
  }
  return null;
}

export { memoryVerdicts, type MemoryVerdictRow } from "./memory-state";

export interface SaveVerdictInput {
  tenantId: string;
  userId: string;
  /** Null for verdicts that did not come from a chat (inbound mail). */
  conversationId?: string | null;
  /** The artifact the verdict is about (first chat attachment, or the forwarded .eml). */
  artifactId?: string | null;
  source: VerdictSource;
  verdict: Verdict;
}

/**
 * Store a verdict: @neo/db `saveVerdict` with a database, else the shared
 * in-memory rows (lib/server/memory-state.ts). Throws on failure; chat callers
 * use `saveChatVerdict`, which never throws.
 */
export async function saveVerdict(input: SaveVerdictInput): Promise<{ id: string }> {
  const db = getDb();
  if (!db) return saveMemoryVerdict(input);
  return dbSaveVerdict(db, input);
}

/** Store a chat verdict. Never throws: the user already has their answer. */
export async function saveChatVerdict(input: Omit<SaveVerdictInput, "source">): Promise<string | undefined> {
  try {
    return (await saveVerdict({ ...input, source: "chat" })).id;
  } catch (err) {
    logger.error("Verdict write failed", "verdicts", {
      tenantId: input.tenantId,
      userIdHash: hashPii(input.userId),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      errorMessage: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
    });
    return undefined;
  }
}
