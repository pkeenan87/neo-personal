/**
 * Pull the ```verdict block out of the agent's final answer and store it as a
 * `verdicts` row (tenant-scoped). The block is validated with VerdictSchema
 * (via splitVerdictSegments); invalid blocks are ignored here and rendered by
 * the UI as an "invalid verdict" notice.
 */
import { hashPii, logger, type MessageParam } from "@neo/core";
import { tenantScoped, verdicts } from "@neo/db";
import type { Verdict } from "@neo/verdict";
import { splitVerdictSegments } from "@/lib/verdict-fence";
import { getDb } from "./db";

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

export interface MemoryVerdictRow {
  // --- dashboard (agent E): id/source/artifactId so the no-database fallback can serve /api/verdicts ---
  id?: string;
  source?: "chat" | "inbound" | "api";
  artifactId?: string | null;
  // --- end dashboard ---
  tenantId: string;
  userId: string;
  conversationId: string | null;
  verdict: Verdict;
  /** Phase 1 intake: the first artifact attached to the turn that produced the verdict. */
  artifactId?: string;
  createdAt: Date;
}

const g = globalThis as typeof globalThis & { __neoMemoryVerdicts?: MemoryVerdictRow[] };

/** No-database fallback (MOCK_MODE / tests). */
export function memoryVerdicts(): MemoryVerdictRow[] {
  g.__neoMemoryVerdicts ??= [];
  return g.__neoMemoryVerdicts;
}

/** Store a verdict. Never throws: the user already has their answer. */
export async function saveVerdict(input: {
  tenantId: string;
  userId: string;
  conversationId: string;
  verdict: Verdict;
  /** Phase 1 intake. TODO(integration): write verdicts.artifact_id (migration 0003_phase1) via @neo/db saveVerdict. */
  artifactId?: string;
}): Promise<void> {
  const { tenantId, userId, conversationId, verdict } = input;
  try {
    const db = getDb();
    if (!db) {
      const rows = memoryVerdicts();
      rows.push({ id: crypto.randomUUID(), source: "chat", artifactId: null, ...input, createdAt: new Date() });
      if (rows.length > 1000) rows.splice(0, rows.length - 1000);
      return;
    }
    await tenantScoped(db, tenantId).insert(verdicts, {
      userId,
      conversationId,
      subjectType: verdict.subject_type,
      verdict: verdict.verdict,
      confidence: verdict.confidence,
      headline: verdict.headline,
      body: verdict as unknown as Record<string, unknown>,
    });
  } catch (err) {
    logger.error("Verdict write failed", "verdicts", {
      tenantId,
      userIdHash: hashPii(userId),
      conversationId,
      errorMessage: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
    });
  }
}
