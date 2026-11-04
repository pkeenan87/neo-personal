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
export { BUDGET_EXHAUSTED_MESSAGE, REFUSAL_MESSAGE, isBudgetExhaustedError, resumeAfterConfirmation, runAgentLoop } from "./agent.js";

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
  AI_GATEWAY_BASE_URL,
  agentModel,
  compressionModel,
  enabledFamilies,
  fallbacksEnabled,
  gatewayEnabled,
  gatewayRegion,
  refusalFallbacksEnabled,
} from "./config.js";
export type { EnvSource } from "./config.js";

// Model client and gateway request policy (Phase 2)
export {
  createModelClient,
  gatewayProviderOptions,
  modelEntryFor,
  requestShape,
  resetModelClientForTests,
  servedModelOf,
  withGatewayOptions,
} from "./client.js";
export type { GatewayInferenceRegion, GatewayProviderOptions, RequestShape } from "./client.js";

// Model catalog and routing (Phase 2)
export {
  MODEL_CATALOG,
  MODEL_FAMILIES,
  PREFERENCE_TABLE,
  ROUTING_PREFERENCES,
  TIERS,
  anthropicModelFor,
  catalogEntryFor,
  catalogModel,
  clampEffort,
  directModelId,
  displayNameFor,
  gatewayModelId,
  modelIdFor,
  pinnedRoute,
  resolveRoute,
} from "./routing.js";
export type { CatalogModel, ModelFamily, ResolveRouteInput, Route, RouteSignals, RouterKind, RoutingPreference, Tier } from "./routing.js";

// Model spend cap maths (_specs/v2-m3-cutover.md section 6)
export {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  SPEND_CAP_MAX_CENTS,
  SPEND_CAP_MIN_CENTS,
  estimateCostCents,
  isValidSpendCapCents,
  monthWindow,
  spendLevel,
} from "./spend.js";
export type { MonthWindow, SpendLevel, SpendTokens } from "./spend.js";

// Per-household retention settings (_specs/v2-m4-hardening.md section 1)
export { DEFAULT_RETENTION, RETENTION_BOUNDS, RETENTION_KINDS, isValidRetentionDays } from "./retention.js";
export type { RetentionBound, RetentionKind, RetentionSettings } from "./retention.js";

// Artifact crypto (envelope encryption at rest)
export {
  ARTIFACT_CIPHERTEXT_OVERHEAD,
  ArtifactDecryptError,
  decryptArtifact,
  deriveKey,
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
export { generateModelText } from "./model-text.js";
export type { ModelTextCall, ModelTextClient, ModelTextResponse } from "./model-text.js";

// Account-hardening checklist and score (pure, deterministic)
export {
  ACCOUNT_HARDENING_MANIFESTS,
  ACCOUNT_HARDENING_MAX_NEXT_ACTIONS,
  ACCOUNT_HARDENING_MIN_ANSWERS,
  ACCOUNT_HARDENING_STALE_AFTER_MS,
  ACCOUNT_HARDENING_V1,
  CURRENT_ACCOUNT_HARDENING_MANIFEST,
  CURRENT_ACCOUNT_HARDENING_VERSION,
  isAccountHardeningAnswerAllowed,
  isAccountHardeningItemId,
  isAccountHardeningStale,
  scoreAccountHardening,
} from "./account-hardening.js";
export type {
  AccountHardeningAnswerInput,
  AccountHardeningEvidence,
  AccountHardeningEvidenceId,
  AccountHardeningHelpLink,
  AccountHardeningItemId,
  AccountHardeningManifest,
  AccountHardeningManifestItem,
  AccountHardeningScore,
  AccountHardeningState,
  AccountHardeningVersion,
} from "./account-hardening.js";
export * from "./policy/index.js";
