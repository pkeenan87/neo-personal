# Package contracts (Phase 0)

Every workspace package is `@neo/<name>`, ESM, TypeScript, built with `tsc` to `dist/` (apps/web is a Next.js app and is not built with tsc).
Every package exposes the scripts `build`, `typecheck` (`tsc --noEmit`), `lint` (`eslint .`), `test` (`vitest run`). Tests live in `<pkg>/test/`.
Each package `tsconfig.json` extends `../../tsconfig.base.json`. Packages import each other by workspace name (`"@neo/core": "workspace:*"`).

Model IDs (from the claude-api skill, 2026-09): chat agent `claude-opus-5`; bulk triage `claude-sonnet-5`; compression/titles `claude-haiku-4-5`.
Adaptive thinking is on by default on these models: never send `budget_tokens`; control depth with `output_config.effort`. No assistant prefill. Read the claude-api skill TypeScript README before writing SDK code.

## @neo/verdict

```ts
export const VerdictSchema: z.ZodType<Verdict>;   // zod
export type Verdict = {
  subject_type: "email" | "sms" | "url" | "page" | "signin_alert" | "file" | "conversation";
  verdict: "malicious" | "suspicious" | "likely_safe" | "insufficient_evidence";
  confidence: number;                               // 0..1
  headline: string;                                 // one sentence for the user
  indicators: { severity: "low"|"medium"|"high"|"critical"; category: string; evidence: string; explanation: string }[];
  recommended_actions: { action: string; urgency: "now"|"soon"|"optional"; deep_link?: string }[];
  iocs: { urls: string[]; domains: string[]; ips: string[]; hashes: string[]; phone_numbers: string[] };
  raw_ref?: string;                                 // artifact id
};
export const verdictJsonSchema: Record<string, unknown>; // JSON schema for Claude structured outputs / tool input
```

## @neo/core  (lifted from ../Neo/web/lib, Azure-free)

```ts
// Tool registry — the agent never imports concrete tools
export interface ToolDefinition { name: string; description: string; input_schema: Record<string, unknown>; destructive?: boolean; strict?: boolean }
export type ToolContext = { tenantId: string; userId: string; conversationId: string; signal?: AbortSignal };
export type ToolExecutor = (input: unknown, ctx: ToolContext) => Promise<unknown>;
export interface ToolRegistry { list(): ToolDefinition[]; get(name: string): { definition: ToolDefinition; execute: ToolExecutor } | undefined }
export function createToolRegistry(tools: Array<{ definition: ToolDefinition; execute: ToolExecutor }>): ToolRegistry;

// Agent loop
export type AgentEvent =                      // NDJSON events streamed to clients
  | { type: "text_delta"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; result: unknown; is_error?: boolean }
  | { type: "confirmation_required"; id: string; name: string; input: unknown; description: string }
  | { type: "usage"; input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
  | { type: "done"; stop_reason: string }
  | { type: "error"; message: string };
export interface RunAgentOptions {
  messages: MessageParam[];                   // from @anthropic-ai/sdk
  system: string;
  tools: ToolRegistry;
  ctx: ToolContext;
  model?: string;                             // default claude-opus-5
  effort?: "low"|"medium"|"high";             // default medium
  maxTokens?: number;
  onEvent: (e: AgentEvent) => void | Promise<void>;
}
export interface AgentResult { messages: MessageParam[]; pendingConfirmation?: { id: string; name: string; input: unknown }; usage: { input_tokens: number; output_tokens: number } }
export function runAgentLoop(opts: RunAgentOptions): Promise<AgentResult>;
export function resumeAfterConfirmation(opts: RunAgentOptions & { approved: boolean; pending: { id: string; name: string; input: unknown } }): Promise<AgentResult>;

// Safeguards
export function scanUserInput(text: string, ctx: { conversationId?: string }): ScanResult;
export function shouldBlock(r: ScanResult): boolean;
export function wrapToolResult(toolName: string, result: unknown, ctx: { conversationId?: string }): string;  // trust-boundary envelope
export function prepareMessages(messages: MessageParam[], opts?: { maxInputTokens?: number }): Promise<MessageParam[]>; // truncation + Haiku compression
export function encodeEvent(e: AgentEvent): string;   // NDJSON line
export const logger: { debug; info; warn; error };     // console, allowlisted metadata, hashPii()
export function hashPii(v: string): string;

// Persistence interface (implemented by @neo/db)
export interface ConversationStore {
  create(input: { tenantId: string; userId: string; title?: string }): Promise<{ id: string }>;
  get(id: string, tenantId: string): Promise<{ id: string; messages: MessageParam[]; pendingConfirmation?: unknown } | undefined>;
  appendTurn(id: string, tenantId: string, turn: { messages: MessageParam[]; usage?: { input_tokens: number; output_tokens: number }; pendingConfirmation?: unknown | null }): Promise<void>;
  list(tenantId: string, userId: string): Promise<Array<{ id: string; title: string | null; updatedAt: Date }>>;
  delete(id: string, tenantId: string): Promise<void>;
}
```

## @neo/tools

```ts
export const checkUrlTool: { definition: ToolDefinition; execute: ToolExecutor };   // name "check_url"
export function analyzeUrl(url: string, opts?: { deps?: Partial<UrlAnalysisDeps>; signal?: AbortSignal }): Promise<UrlAnalysis>;
export type UrlAnalysis = { normalized_url: string; final_url?: string; redirect_chain: string[]; domain: { registrable: string; age_days?: number; registrar?: string; created?: string }; reputation: { safe_browsing?: {...}; virustotal?: {...}; urlscan?: {...} }; tls?: {...}; lookalike?: { brand: string; technique: string } | null; heuristics: string[]; errors: string[] };
```
Every external client reads its key from env and returns `{ skipped: "no_api_key" }` when unset. `MOCK_MODE=true` returns deterministic fixtures for a fixed set of test URLs. The agent (not this package) produces the Verdict from `UrlAnalysis`.

## @neo/db

```ts
export const schema: { tenants, users, memberships, conversations, turns, verdicts, artifacts, auditEvents, usageEvents, ... };  // drizzle-orm/pg-core
export function createDb(connectionString?: string): Db;          // @neondatabase/serverless in prod, node-postgres locally (DATABASE_URL)
export function tenantScoped(db: Db, tenantId: string): TenantDb; // every query helper on TenantDb injects tenant_id; also SETs app.tenant_id for RLS
export function createConversationStore(db: Db): ConversationStore;   // implements @neo/core ConversationStore
export const usage: {
  checkCaps(db: Db, tenantId: string): Promise<{ allowed: boolean; reason?: "monthly_checks" | "daily_tokens"; remaining: {...} }>;
  recordCheck(db: Db, input: { tenantId: string; userId: string; conversationId?: string; model: string; inputTokens: number; outputTokens: number }): Promise<void>;
};
export function createTenantForUser(db: Db, input: { userId: string; name: string }): Promise<{ tenantId: string }>;  // household, role "owner"
```
Caps come from env: `USAGE_CAP_MONTHLY_CHECKS` (default 50), `USAGE_CAP_DAILY_TOKENS` (default 300000). RLS policies in a migration keyed on `current_setting('app.tenant_id', true)`.

## apps/web  (Next.js 16 App Router, Node runtime)

Routes: `/` marketing+login, `/chat`, `/chat/[id]`, `/api/agent` (POST, NDJSON stream), `/api/agent/confirm` (POST), `/api/conversations` (GET/DELETE), `/api/auth/[...nextauth]`, `/api/health`.
Auth: Auth.js v5 with Google and Resend magic link; Drizzle adapter on @neo/db; on first sign-in `createTenantForUser`. Session carries `{ userId, tenantId, role }`.
`/api/agent` order: auth → `usage.checkCaps` (429 if not allowed) → `scanUserInput` → load conversation → `runAgentLoop` with `createToolRegistry([checkUrlTool])` → `appendTurn` + `usage.recordCheck`.
