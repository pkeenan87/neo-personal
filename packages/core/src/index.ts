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
export { estimateTokens, IMAGE_OMITTED_TEXT, omitOlderImages, prepareMessages } from "./context-manager.js";
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

// Artifact crypto (envelope encryption at rest)
export {
  ARTIFACT_CIPHERTEXT_OVERHEAD,
  ArtifactDecryptError,
  decryptArtifact,
  deriveTenantKey,
  encryptArtifact,
  masterKeyFromEnv,
} from "./artifact-crypto.js";

// Bulk triage (structured outputs)
export {
  DEFAULT_TRIAGE_MAX_TOKENS,
  DEFAULT_TRIAGE_MODEL,
  TRIAGE_SYSTEM_PROMPT,
  buildTriageRequest,
  createMockTriageClient,
  parseTriageResponse,
  runTriage,
  triageFailedVerdict,
  triageModel,
} from "./triage.js";
export type { RunTriageInput, TriageEvidenceKind, TriageResult } from "./triage.js";
