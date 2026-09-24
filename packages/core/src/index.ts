// Public API of @neo/core — see docs/contracts.md.

// Types
export type {
  AgentEvent,
  AgentResult,
  AgentUsage,
  ConversationStore,
  Effort,
  PendingConfirmation,
  RegisteredTool,
  RunAgentOptions,
  ScanResult,
  ToolContext,
  ToolDefinition,
  ToolExecutor,
  ToolRegistry,
} from "./types.js";
// Re-exported so dependants (e.g. @neo/db) name the persisted message type without importing the SDK.
export type { MessageParam } from "@anthropic-ai/sdk/resources/messages";

// Tool registry
export { createToolRegistry } from "./tool-registry.js";

// Agent loop
export { REFUSAL_MESSAGE, resumeAfterConfirmation, runAgentLoop } from "./agent.js";

// Safeguards
export { guardMode, scanUserInput, shouldBlock, wrapToolResult } from "./injection-guard.js";
export type { GuardMode, TrustBoundaryEnvelope } from "./injection-guard.js";
export { estimateTokens, prepareMessages } from "./context-manager.js";
export type { PrepareMessagesOptions } from "./context-manager.js";
export { NDJSON_CONTENT_TYPE, createEventStream, decodeEvent, encodeEvent } from "./stream.js";
export { SAFE_METADATA_FIELDS, hashPii, logger } from "./logger.js";
export type { LogLevel, Logger } from "./logger.js";

// Config
export {
  DEFAULT_AGENT_MODEL,
  DEFAULT_COMPRESSION_MODEL,
  DEFAULT_EFFORT,
  DEFAULT_MAX_TOKENS,
  agentModel,
  compressionModel,
  fallbacksEnabled,
} from "./config.js";
