import { createHash } from "node:crypto";

/**
 * Console-only structured logger, lifted from Neo's `web/lib/logger.ts`
 * with the Event Hub sinks removed. Two safety properties carry over:
 *
 *  1. Metadata is allowlisted: only keys in SAFE_METADATA_FIELDS are
 *     emitted, so a caller cannot accidentally log an email body, a tool
 *     result, or a raw user id by passing it in metadata.
 *  2. `hashPii` gives a stable, one-way correlation id for identifiers
 *     that must never appear in logs verbatim (user ids, emails).
 *
 * Each entry is a single JSON line, so embedded newlines in messages
 * cannot forge extra log lines.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** One-way SHA-256 hash truncated to 16 hex chars. */
export function hashPii(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/**
 * Metadata keys allowed through to the log sink. Everything else is
 * dropped silently. Add a key here only if its values can never carry
 * PII or attacker-controlled free text (or are hashed at the call site).
 */
export const SAFE_METADATA_FIELDS: ReadonlySet<string> = new Set([
  // identity / correlation (ids are opaque; user ids must be hashed)
  "tenantId",
  "conversationId",
  "userIdHash",
  "requestId",
  "component",
  // model / API
  "model",
  "servedByModel",
  "effort",
  "maxTokens",
  "stopReason",
  "refusalCategory",
  "statusCode",
  "errorType",
  "errorMessage",
  "attempt",
  "maxRetries",
  "delayMs",
  "iteration",
  "fallbacksEnabled",
  // usage
  "inputTokens",
  "outputTokens",
  "cacheCreationTokens",
  "cacheReadTokens",
  "cacheHitRate",
  // tools
  "toolName",
  "toolId",
  "toolUseId",
  "toolCount",
  "isDestructive",
  "isError",
  "durationMs",
  "approved",
  "dropped",
  // injection guard
  "label",
  "labels",
  "matchCount",
  "messageLength",
  "mode",
  "blocked",
  // context management
  "messageCount",
  "messageIndex",
  "contentType",
  "estimatedTokens",
  "ceiling",
  "threshold",
  "remainingMessages",
  "droppedCount",
  "droppedFromIndex",
  "droppedMessages",
  "originalTokens",
  "afterEnforcementTokens",
  "originalChars",
  "truncatedChars",
  "reason",
  "method",
]);

function sanitizeMetadata(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  const safe: Record<string, unknown> = {};
  let hasKeys = false;
  for (const key of Object.keys(meta)) {
    if (SAFE_METADATA_FIELDS.has(key) && meta[key] !== undefined) {
      safe[key] = meta[key];
      hasKeys = true;
    }
  }
  return hasKeys ? safe : undefined;
}

function minLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL?.toLowerCase();
  if (raw && raw in LEVEL_PRIORITY) return raw as LogLevel;
  if (process.env.NODE_ENV === "test") return "warn";
  return "info";
}

function log(level: LogLevel, message: string, component: string, metadata?: Record<string, unknown>): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minLevel()]) return;
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    component,
    msg: message,
  };
  const meta = sanitizeMetadata(metadata);
  if (meta) entry.meta = meta;
  const line = JSON.stringify(entry);
  switch (level) {
    case "error":
      console.error(line);
      break;
    case "warn":
      console.warn(line);
      break;
    default:
      console.log(line);
  }
}

export interface Logger {
  debug(message: string, component: string, metadata?: Record<string, unknown>): void;
  info(message: string, component: string, metadata?: Record<string, unknown>): void;
  warn(message: string, component: string, metadata?: Record<string, unknown>): void;
  error(message: string, component: string, metadata?: Record<string, unknown>): void;
}

export const logger: Logger = {
  debug: (m, c, meta) => log("debug", m, c, meta),
  info: (m, c, meta) => log("info", m, c, meta),
  warn: (m, c, meta) => log("warn", m, c, meta),
  error: (m, c, meta) => log("error", m, c, meta),
};
