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

Shipped additions: `verdictJsonSchema` is strict (every object `additionalProperties: false`) and has no `minimum`/`maximum`/length keywords (validate with `VerdictSchema`, which enforces them). Also exported: `summarizeVerdict(v)` (one-line text), `verdictSeverityRank`, and the literal lists `SUBJECT_TYPES`, `VERDICTS`, `SEVERITIES`, `URGENCIES` with types `SubjectType`, `VerdictLabel`, `Severity`, `Urgency`. `VerdictSchema` is `.strict()`: unknown keys are rejected.

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

Shipped additions (all additive; nothing above changed):
- `RunAgentOptions` also takes `client?: Anthropic` (inject a client; tests and `MOCK_MODE` pass a scripted fake), `enableFallbacks?` (server-side refusal fallbacks via the beta namespace; default env `NEO_ENABLE_FALLBACKS`, on; a fake client without `beta` needs `false`), `maxIterations?` (default 20), `retry?`.
- `AgentResult` also has `newMessages` (only what this run appended: persist these with `appendTurn`), `stopReason` (API stop reason, or `confirmation_required` | `interrupted` | `error` | `max_iterations`), and `error?` (user-safe text). `usage` includes `cache_read_input_tokens` / `cache_creation_input_tokens`. `pendingConfirmation` is persisted as is.
- `runAgentLoop` / `resumeAfterConfirmation` never throw; `done` is always the last event.
- `createEventStream(): { readable, send, close }` for NDJSON responses (pass `onEvent: send`, `close()` when finished), `NDJSON_CONTENT_TYPE`, `decodeEvent`.
- `scanUserInput` also accepts content blocks; `shouldBlock` is true only in `INJECTION_GUARD_MODE=block` with >= 2 pattern matches.
- `logger.<level>(message, component, metadata?)`; metadata keys are allowlisted (`SAFE_METADATA_FIELDS`); the only safe user identifier is `userIdHash` from `hashPii`.
- `export type { MessageParam }` (re-exported from the SDK so dependants need not import it), config helpers `agentModel()`, `compressionModel()`, `fallbacksEnabled()`, `DEFAULT_*`.
- Env: `NEO_AGENT_MODEL`, `NEO_COMPRESSION_MODEL`, `NEO_ENABLE_FALLBACKS`, `NEO_CONTEXT_MAX_INPUT_TOKENS`, `NEO_TOOL_RESULT_MAX_TOKENS`, `INJECTION_GUARD_MODE`, `LOG_LEVEL`.

## @neo/tools

```ts
export const checkUrlTool: { definition: ToolDefinition; execute: ToolExecutor };   // name "check_url"
export function analyzeUrl(url: string, opts?: { deps?: Partial<UrlAnalysisDeps>; signal?: AbortSignal }): Promise<UrlAnalysis>;
export type UrlAnalysis = { normalized_url: string; final_url?: string; redirect_chain: string[]; domain: { registrable: string; age_days?: number; registrar?: string; created?: string }; reputation: { safe_browsing?: {...}; virustotal?: {...}; urlscan?: {...} }; tls?: {...}; lookalike?: { brand: string; technique: string } | null; heuristics: string[]; errors: string[] };
```
Every external client reads its key from env and returns `{ skipped: "no_api_key" }` when unset. `MOCK_MODE=true` returns deterministic fixtures for a fixed set of test URLs. The agent (not this package) produces the Verdict from `UrlAnalysis`.

Shipped additions: `createCheckUrlTool({ deps })` builds `check_url` with injected dependencies (apps/web passes a process-wide `cache`); `URL_ANALYSIS_GUIDANCE` is the system-prompt fragment for weighing results into a Verdict; `extractUrlIocs(analysis)` returns Verdict `iocs`; `MOCK_URLS` lists the fixture URLs (any other URL gets a plausible clean mock result). `UrlAnalysis` also carries `input`, `display_url`, `page`, `final_domain`, `analyzed_at`, `cached?`, `mock?`. Node runtime only (tls, dns, undici); worst case per call ~15 s, ~40 s with urlscan. `VIRUSTOTAL_SUBMIT` (default true) controls submitting unknown URLs to VirusTotal; `URLSCAN_ENABLED` (default false) enables urlscan.io.

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

Shipped differences and additions:
- `usage.checkCaps` returns `{ allowed, reason?, remaining, used, limits, resetAt: { monthlyChecks, dailyTokens } }` (`resetAt` = start of the next UTC month / day). It counts only `kind = 'check'` rows as checks.
- `usage.recordCheck` also takes `cacheReadTokens?`, `cacheCreationTokens?` and `kind?: "check" | "resume"` (default `check`; confirm resumptions record `resume`, which counts tokens but not checks). Column `usage_events.kind` (migration `0002_usage_kind`).
- `usage.recordCapHit(db, { tenantId, userId, reason, limit, used, resetAt })` writes at most one `usage.cap_hit` audit event per tenant, reason and period; returns whether it wrote.
- `findTenantForUser(db, userId) → { tenantId, role } | undefined` (for the Auth.js session). `createTenantForUser` is idempotent per user and writes `tenant.created`.
- Auth.js tables `users`, `accounts`, `sessions`, `verificationTokens`, `authenticators` are exported for `DrizzleAdapter(db, { usersTable, accountsTable, sessionsTable, verificationTokensTable, authenticatorsTable })`.
- `createDb()` opens a pool: call it once per process. The migration runner is only at the `@neo/db/migrate` subpath (`runMigrations`, `migrationsFolder`) so app bundles never include it. The app connects as a non-owner role (`DATABASE_URL`) so RLS applies; migrations use `MIGRATION_DATABASE_URL` (owner). See `packages/db/docs/rls.md`.
- `appendTurn` with an empty `messages` array only updates `pendingConfirmation` (no empty turn row).

## apps/web  (Next.js 16 App Router, Node runtime)

Routes: `/` marketing+login, `/chat`, `/chat/[id]`, `/api/agent` (POST, NDJSON stream), `/api/agent/confirm` (POST), `/api/conversations` (GET/DELETE), `/api/usage` (GET), `/api/auth/[...nextauth]`, `/api/health`.
Auth: Auth.js v5 with Google and Resend magic link; Drizzle adapter on @neo/db; on first sign-in `createTenantForUser`. Session carries `{ userId, tenantId, role }`.
`/api/agent` order: auth → `usage.checkCaps` (429 if not allowed) → `scanUserInput` → load conversation → `runAgentLoop` with `createToolRegistry([checkUrlTool])` → `appendTurn` + `usage.recordCheck`.

### HTTP contract (as shipped)

Every API route runs on the Node runtime; `/api/agent` and `/api/agent/confirm` set `maxDuration = 300` (also in `apps/web/vercel.json`). JSON errors are `{ error: <message>, code? }` except the usage-cap 429 below.

- `POST /api/agent` `{ conversationId?, message }` → 200 NDJSON `AgentEvent` lines, header `x-conversation-id`. Errors: 400 `bad_request` / `message_too_long` / `input_blocked` (injection guard in block mode), 401 `unauthenticated`, 404 `not_found` (unknown id or another tenant's), 409 `confirmation_pending` (answer the pending action first), 429 usage cap, 503 `usage_unavailable` (cap check failed: fail closed), `storage_unavailable`, `agent_unavailable` (no `ANTHROPIC_API_KEY` and not `MOCK_MODE`). The turn (user message + `newMessages`, usage, `pendingConfirmation`) is appended and `usage.recordCheck` is written after the loop ends for every stop reason, including errors and client aborts; then the stream closes.
- `POST /api/agent/confirm` `{ conversationId, id, approved }` → 200 NDJSON (resumed turn). 409 `no_pending_confirmation` when nothing is pending or the id differs. Approving checks only the daily token cap (429 / 503 fail closed); declining is always allowed. Usage is recorded with `kind: "resume"`.
- 429 body: `{ error: "usage_cap_exceeded", reason: "monthly_checks" | "daily_tokens", limit, resetAt, message }` with `Retry-After` seconds. At most one `usage.cap_hit` audit event per tenant, reason and period.
- `GET /api/conversations` → `{ conversations: [{ id, title, updatedAt }] }` for the session user in the session tenant; `DELETE /api/conversations?id=` → 204, 404 for unknown or foreign ids.
- `GET /api/usage` → `{ monthlyChecks: { used, limit, resetAt }, dailyTokens: { used, limit, resetAt } }`.

### Verdicts in chat

The system prompt (`apps/web/lib/server/system-prompt.ts`) tells the model to end every analysis with exactly one fenced block whose info string is `verdict` and whose body is a `Verdict` JSON object (schema from `verdictJsonSchema`). The UI renders it as a verdict card (`lib/verdict-fence.ts`); the route validates the block in the final assistant message with `VerdictSchema` and inserts a `verdicts` row. The block is prose-embedded rather than a structured-output call so one streamed turn carries both the explanation and the verdict.

### Modes

- `MOCK_MODE=true`: the real agent loop runs against a scripted offline model (`lib/server/mock-model.ts`, passed as `client`), `check_url` runs in @neo/tools mock mode, and a destructive demo tool `report_phish_demo` is registered (send a message containing `confirm-test`) to exercise the confirmation gate. No API key or network needed.
- No `DATABASE_URL`: conversations, usage, audit events and verdicts use in-memory fallbacks (per process), and no sign-in provider is registered; only `DEV_AUTH_BYPASS` signs in (fixed in-memory dev tenant). For local demos and CI only.
- `DEV_AUTH_BYPASS=true` is honoured only when `NODE_ENV !== "production"` and `VERCEL_ENV` is neither `production` nor `preview`.

---

# Package contracts (Phase 1)

Additive to Phase 0. Full shapes live in the specs; this section fixes the names and ownership so parallel work lines up. Rule: an agent that needs an interface from another package builds against **this** shape and, if the owning package is not merged yet, a local stub under `test/` or a typed placeholder; the integration pass swaps in the real export.

## @neo/tools (spec `_specs/email-analysis.md`, `_specs/sms-analysis.md`)

```ts
export function parseEmail(raw: string | Uint8Array): Promise<ParsedEmail>;
export function analyzeEmail(input: EmailInput, opts?: { deps?: Partial<UrlAnalysisDeps>; signal?: AbortSignal; maxUrls?: number }): Promise<EmailAnalysis>;
export const analyzeEmailTool: RegisteredTool;                       // "analyze_email"; input { artifact_ref? | raw? | pasted? } (exactly one)
export function createAnalyzeEmailTool(opts: { deps?: Partial<UrlAnalysisDeps>; loadArtifact?: (ref: string, ctx: ToolContext) => Promise<Uint8Array | undefined> }): RegisteredTool;
export const EMAIL_ANALYSIS_GUIDANCE: string;
export function extractEmailIocs(a: EmailAnalysis): Verdict["iocs"];
export function analyzeSms(input: SmsInput, opts?: { deps?: Partial<UrlAnalysisDeps>; signal?: AbortSignal }): Promise<SmsAnalysis>;
export const analyzeSmsTool: RegisteredTool;                         // "analyze_sms"; input { sender?, body, received_at?, user_country? }
export function createAnalyzeSmsTool(opts: { deps?: Partial<UrlAnalysisDeps> }): RegisteredTool;
export const SMS_ANALYSIS_GUIDANCE: string;
export function extractSmsIocs(a: SmsAnalysis): Verdict["iocs"];
export type { ParsedEmail, EmailInput, EmailAnalysis, SmsInput, SmsAnalysis };
```
Both tools are read-only, `strict: true`, never throw for analysis failures (`errors[]`), and never fetch attachments or render HTML. Mock mode: offline parsing plus the Phase 0 URL mock. `loadArtifact` receives the `ToolContext` and must scope by `ctx.tenantId`.

Shipped additions (all additive; the names above are exported exactly as listed):
- `execute` throws (zod) only for invalid input: not exactly one of `artifact_ref`/`raw`/`pasted`, `raw` over 512 KB (UTF-8 bytes), SMS `body` over 4000 chars, `user_country` not two letters. `null` for an optional field is treated as absent. Artifact problems are results, not throws: `errors: ["artifact_not_found"]` (loader returned `undefined`), `["artifact_load_failed"]` (loader threw; logged with `tenantId` only), `["artifact_store_unavailable"]` (no loader: the default `analyzeEmailTool`). apps/web must register `createAnalyzeEmailTool({ deps, loadArtifact })`, with `loadArtifact = (ref, ctx) => artifactStore.read(ref, ctx.tenantId)` (return `undefined` for other tenants' ids and for `image` artifacts). `eml`/`inbound_eml` bytes are parsed as MIME; bytes with no recognizable message headers (a `text` artifact) are analyzed as a pasted body (`input_kind: "raw"`, `headers_present: false`).
- Other analyzer errors: `unsupported_format` (OLE/.msg), `parse_failed`, `empty_input`, `truncated: ...` (message > 4 MB or HTML > 512 KB was cut), `virustotal_file: ...`, SMS `urls_truncated: ...`.
- `analyzeEmail` options also take `maxUrls` (default 8, hard cap 8); `analyzeSms` takes `maxUrls` (default 5, hard cap 5; at most 5 URLs listed). Email lists at most 50 URLs (duplicates are merged, not listed; `skipped: "duplicate"` is never emitted) and 50 attachments; strings are capped at 2048 chars, `text_excerpt` at 2000, `body_excerpt` at 1000. `analyzed_at` is fixed (`2026-01-15T12:00:00.000Z`) in mock mode.
- `EmailAnalysis` also has `phone_numbers` (callback numbers, E.164 when parseable), `authentication.compauth` (Microsoft), and per attachment `extension` and `flags` (`ole_document`, `archive_not_inspected`, `macro_enabled`, `rtlo_in_name`, `inline`); attachment `virustotal` is a file report (`GET /files/{sha256}`, lookup only, at most 5 per message) or `{ status: "not_found" }` or `{ skipped: "no_api_key" | "mock" | "limit" | "not_applicable" | "error" }`. `ParsedEmail` adds `fromCount`, `headersSynthetic`, `truncated`.
- Heuristic catalogs with descriptions: `EMAIL_HEURISTIC_CODES`, `SMS_HEURISTIC_CODES`. Codes beyond the spec lists: email `missing_from`, `multiple_from`, `unicode_tricks_in_display_name`, `display_name_address_mismatch`, `spf_softfail`, `url_reputation_flagged`, `url_brand_lookalike`, `url_non_web_scheme`, `many_urls`, `ole_document`, `archive_not_inspected`, `callback_number_present`; SMS `reply_to_activate_link`, `group_message`, `non_english_body`, `link_only_message`, `first_seen_domain_lt_30d`, `url_reputation_flagged`, `url_brand_lookalike`.
- Also exported: `createAnalyzeSmsTool`/`createAnalyzeEmailTool` definitions and zod schemas (`analyzeEmailDefinition`, `AnalyzeEmailInputSchema`, `analyzeSmsDefinition`, `AnalyzeSmsInputSchema`), `emailErrorResult`, `parsePasted`, `detectMagic`, `EmailParseError`, `evaluateAuthentication`, `parseAuthResultsValue`, `analyzeHtml`, `triageAttachment`, `checkVirusTotalFile`, `classifySmsSender`, `stripChrome`, `parsePhone`, `extractPhoneNumbers`, `extractTextUrls`, `refang`, `isFreeMailDomain`.
- Data tables that can grow without code changes live in `packages/tools/src/data/` (`sms-lures.json`, `email-signals.json`, `injection-patterns.json`, `free-mail-providers.json`, `dangerous-extensions.json`, `country-calling-codes.json`, `nanp-area-codes.json`). New runtime dependency: `postal-mime` 3.0.0. No new env vars (`VIRUSTOTAL_API_KEY` is reused).
- Logging: one `info` line per analysis with auth outcomes and counts in the message and heuristic codes in `labels`; no subjects, addresses, bodies, or sender domains (the sender registrable domain is not in `SAFE_METADATA_FIELDS`).

## @neo/core (spec `_specs/intake.md`, `_specs/forward-to-address.md`)

```ts
// Artifact crypto (pure; AES-256-GCM, HKDF per tenant, AAD = artifact id)
export function masterKeyFromEnv(source?: NodeJS.ProcessEnv): Uint8Array | undefined;   // NEO_MASTER_KEY base64 (32 bytes)
export function deriveTenantKey(masterKey: Uint8Array, tenantId: string): Uint8Array;
export function encryptArtifact(key: Uint8Array, plaintext: Uint8Array, aad: string): Uint8Array;
export function decryptArtifact(key: Uint8Array, blob: Uint8Array, aad: string): Uint8Array;  // throws ArtifactDecryptError
export class ArtifactDecryptError extends Error {}

// Bulk triage: one structured-output call on NEO_TRIAGE_MODEL (default claude-sonnet-5), effort low
export function runTriage(input: { evidence: unknown; evidenceKind: "email" | "sms"; guidance: string; client?: Anthropic; model?: string; signal?: AbortSignal }): Promise<{ verdict: Verdict; usage: AgentUsage; model: string }>;
export const TRIAGE_SYSTEM_PROMPT: string;
export function triageModel(): string;                                                   // NEO_TRIAGE_MODEL

// Context manager: image blocks count 1600 tokens; compression replaces older images with "[image omitted]" text blocks.
```

Shipped additions (@neo/core, branch `claude/feature/db-artifacts`):
- `masterKeyFromEnv` accepts standard or URL-safe base64, returns `undefined` when unset/blank, and **throws** when set but not 32 bytes. HKDF uses a fixed salt (`neo-artifact-hkdf-salt-v1`) plus info `neo-artifact-v1:<tenantId>`. Also exported: `ARTIFACT_CIPHERTEXT_OVERHEAD` (32 bytes).
- `runTriage` returns `{ verdict, usage, model, attempts, fallback }` (`fallback: true` = the `triage_failed` verdict). It takes `maxTokens?` (default 4096, not 2048: adaptive thinking shares the budget). Request: `messages.create({ model, max_tokens, system, messages: [one user message], thinking: { type: "adaptive" }, output_config: { effort: "low" | "medium", format: { type: "json_schema", schema: verdictJsonSchema } } })` (non-beta; SDK type `OutputConfig`). `subject_type` is forced to `evidenceKind`. Refusal / `max_tokens` / invalid JSON / schema mismatch → one retry at `medium` → fallback. API errors are thrown (so Inngest retries). Without `client`, `MOCK_MODE=true` uses `createMockTriageClient()` (verdict from analyzer heuristic codes).
- Also exported: `DEFAULT_TRIAGE_MODEL`, `DEFAULT_TRIAGE_MAX_TOKENS`, `buildTriageRequest`, `parseTriageResponse`, `triageFailedVerdict`, `createMockTriageClient`, types `RunTriageInput`, `TriageResult`, `TriageEvidenceKind`. `@neo/core` now depends on `@neo/verdict`.

## @neo/db (specs `_specs/intake.md`, `_specs/forward-to-address.md`, `_specs/dashboard.md`)

Migration `0003_phase1`: `artifacts` + `filename`, `mime_type`, `source`; `verdicts` + `source` (`chat|inbound|api`, default `chat`), `artifact_id`; new `inbound_addresses`, `inbound_messages` with RLS; `security definer` function `resolve_inbound_address(local_part)`.

```ts
export interface BlobClient { put(path: string, bytes: Uint8Array, contentType: string): Promise<{ url: string }>; get(url: string): Promise<Uint8Array | undefined>; del(url: string): Promise<void> }
export function createVercelBlobClient(token?: string): BlobClient;    // @vercel/blob, private access
export function createMemoryBlobClient(): BlobClient;
export type ArtifactKind = "eml" | "image" | "text" | "inbound_eml";
export type ArtifactMeta = { id; tenantId; userId; kind; filename?; mimeType; sizeBytes; sha256; encrypted; source; createdAt; expiresAt: Date | null };
export interface ArtifactStore {
  put(input: { tenantId; userId; kind: ArtifactKind; filename?; mimeType; bytes: Uint8Array; source: "upload" | "inbound" }): Promise<ArtifactMeta>;
  get(id, tenantId): Promise<ArtifactMeta | undefined>;
  read(id, tenantId): Promise<Uint8Array | undefined>;                 // decrypted
  delete(id, tenantId): Promise<void>;
  listExpired(limit: number): Promise<ArtifactMeta[]>;
  purge(id: string): Promise<void>;
}
export function createArtifactStore(db: Db, opts: { blob: BlobClient; masterKey?: Uint8Array; retentionDays?: number; allowPlaintext?: boolean }): ArtifactStore;

export const inbound: {
  ensureAddress(db, tenantId): Promise<{ id: string; localPart: string }>;
  rotateAddress(db, tenantId): Promise<{ id: string; localPart: string }>;
  findActiveByLocalPart(db, localPart): Promise<{ id: string; tenantId: string } | undefined>;  // via resolve_inbound_address()
  recordMessage(db, input: { tenantId; addressId; providerMessageId; fromAddressHash; status: InboundStatus }): Promise<{ id: string }>;
  updateMessage(db, id, tenantId, patch: Partial<{ status: InboundStatus; forwarderUserId; artifactId; verdictId; error; completedAt }>): Promise<void>;
  countRecent(db, addressId, windowMs): Promise<number>;
  listRecent(db, tenantId, limit): Promise<InboundMessageRow[]>;
};
export type InboundStatus = "received" | "analyzing" | "done" | "rejected" | "over_cap" | "failed";
export function generateLocalPart(): string;                            // "check-" + 12 lowercase Crockford base32 chars

export const verdictQueries: {
  list(db, tenantId, opts: { userId?; label?; subjectType?; source?; cursor?; limit? }): Promise<{ items: VerdictRow[]; nextCursor?: string }>;
  get(db, tenantId, id): Promise<VerdictRow | undefined>;
  summary(db, tenantId, opts: { userId?; sinceDays: 7 | 30 | 90 }): Promise<VerdictSummary>;
  remove(db, tenantId, id): Promise<boolean>;
};
export function saveVerdict(db, input: { tenantId; userId; conversationId?; artifactId?; source: "chat" | "inbound" | "api"; verdict: Verdict }): Promise<{ id: string }>;
export function listMembers(db, tenantId): Promise<{ userId; name: string | null; email: string | null; role: "owner" | "member" }[]>;
```

Shipped differences and additions (@neo/db, branch `claude/feature/db-artifacts`):
- Migration `0003_phase1` also adds `artifacts_source_check` (`upload|inbound`), `verdicts_artifact_idx`, a partial unique index "one active inbound address per tenant", FKs `inbound_messages.artifact_id → artifacts` and `verdict_id → verdicts` (both `on delete set null`), and a second `security definer` function `list_expired_artifacts(max_rows)` so retention works as the app role. Both functions: `EXECUTE` revoked from `PUBLIC`, granted to `app_user` (see `packages/db/docs/rls.md`).
- `ArtifactStore.get` / `read` treat expired artifacts as missing. `purge(id, tenantId?)`: pass the `tenantId` from `listExpired()` when running as the app role. `put` without a master key throws `ArtifactStoreUnavailableError` unless `allowPlaintext` (ignored when `VERCEL_ENV=production`). `createArtifactStore` also takes `now?`. `retentionDays` defaults to `NEO_ARTIFACT_RETENTION_DAYS` (30). Also exported: `artifactBlobPath`, `artifactRetentionDays`, `DEFAULT_ARTIFACT_RETENTION_DAYS`, types `PutArtifactInput`, `ArtifactStoreOptions`, `ArtifactSource`.
- `inbound.countRecent(db, tenantId, addressId, windowMs)` takes a **tenantId** (tenant-scoped, RLS-safe; the webhook has it from `findActiveByLocalPart`). `ensureAddress` / `rotateAddress` return `{ id, localPart, address }` (`address` null without `NEO_INBOUND_DOMAIN`). `recordMessage` returns `{ id, duplicate }` (idempotent on `providerMessageId`) and bumps the address's `last_used_at`; its input also takes `error?`. Added `inbound.getMessage(db, id, tenantId)`, `isInboundLocalPart`, `inboundAddressFor`. `findActiveByLocalPart` lowercases/trims and returns undefined for anything not shaped like `check-<12 crockford>` without querying.
- `saveVerdict` validates with `VerdictSchema` (throws on invalid), sets `raw_ref` from `artifactId` when absent, and throws on DB errors (callers that must not fail catch). `verdictQueries.list` throws `InvalidCursorError` on a malformed cursor (route → 400); the cursor carries microsecond precision. `summary` covers whole UTC days (today and the previous `sinceDays - 1`), `perDay` has one entry per day (zero-filled), `topIndicators` / `topDomains` count verdicts (not occurrences), domains lowercased; it also takes `now?`. `remove` does not delete the linked artifact (the route does, via `ArtifactStore.delete`). Types exported: `VerdictRow` (`body: Verdict`), `VerdictSummary`, `VerdictListOptions`, `HouseholdMember`, `InboundMessageRow`, `InboundStatus`, `VerdictSource`, `ArtifactKind`.
- New tables are in `tenantTables`.

## apps/web

New routes: `POST /api/artifacts`, `GET /api/artifacts/[id]`, `POST /api/inbound/resend`, `GET|POST|PUT /api/inngest`, `GET /api/verdicts`, `GET /api/verdicts/summary`, `GET|DELETE /api/verdicts/[id]`, `GET /api/household`, `GET|POST /api/settings/forwarding` (POST = rotate). Pages: `/dashboard`, `/verdicts/[id]`, `/settings/forwarding`.
`POST /api/agent` body gains `attachments?: { id: string }[]` (≤ 5) and `playbook?: PlaybookId`. Tool registry: `check_url`, `analyze_email`, `analyze_sms` (+ mock demo tool).
Inngest: client `apps/web/inngest/client.ts` (id `neo`), functions `email-received` (`neo/email.received`), `artifacts-expire` (cron `0 4 * * *`). `MOCK_MODE` without `INNGEST_EVENT_KEY` runs `email-received` inline from the webhook.
Env added: `NEO_INBOUND_DOMAIN`, `RESEND_WEBHOOK_SECRET`, `RESEND_API_KEY` (alias of `AUTH_RESEND_KEY`), `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`, `BLOB_READ_WRITE_TOKEN`, `NEO_MASTER_KEY`, `NEO_ARTIFACT_RETENTION_DAYS`, `NEO_INBOUND_RATE_LIMIT_PER_HOUR`.

### HTTP contract: intake (as shipped, `_specs/intake.md`)

Wire types live in `apps/web/lib/api-types.ts` (`AgentRequestBody`, `AttachmentInput`, `UploadedArtifact`, `ArtifactUploadResponse`, `UsageResponse`); the browser client is `uploadArtifacts()` / `getUsage()` / `streamAgent({ attachments })` in `lib/agent-client.ts`.

- `POST /api/artifacts` multipart/form-data, one or more `file` fields (≤ 4 per request, ≤ 4 MB total). Kind is decided by content, not the declared type: `.eml` / `message/rfc822` must be UTF-8 without NUL bytes and start with an RFC 5322 header block (≤ 2 MB) → `eml`; PNG / JPEG / WebP / GIF by magic bytes (≤ 3 MB; `mimeType` is the detected type) → `image`; `text/plain` / `.txt` valid UTF-8 (≤ 512 KB) → `text`. Filenames are sanitized (no control/bidi characters, quotes or brackets; ≤ 100 chars). All files are validated before any is stored.
  → 200 `{ artifacts: [{ id, kind, filename, mimeType, sizeBytes, sha256 }] }` in file order. Errors: 400 `bad_request` (not multipart, no `file`, > 4 files), 401 `unauthenticated`, 413 `too_large`, 415 `unsupported_type` (HEIC has its own message), 429 `rate_limited` + `Retry-After` (30 files per tenant per rolling hour, in memory per instance in Phase 1), 503 `storage_unavailable`.
- `GET /api/artifacts/[id]` → 200 decrypted bytes, `Content-Disposition: attachment` (RFC 6266 `filename` + `filename*`), `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; …; sandbox`, `Cross-Origin-Resource-Policy: same-origin`. `?inline=1` on an image artifact → `Content-Disposition: inline` with `Content-Type` fixed to the stored image type; ignored for other kinds. 404 `not_found` for malformed, unknown, expired or another tenant's ids; 401; 503 `storage_unavailable`.
- `POST /api/agent` body `{ conversationId?, message, attachments?: { id }[] }`: ≤ 5 UUID ids (de-duplicated; else 400 `bad_request`); `message` may be empty when attachments are given (the stored text becomes "Can you check this for me?"). Each id is looked up in the session tenant: 404 `not_found` if any is missing, expired or foreign; 503 `storage_unavailable` if artifacts are unconfigured. The user `MessageParam` is persisted as content blocks: the text, then per attachment a note text block, and for images the image itself:
  - `[Attached file: <filename> (<eml|text>, <size>). Use analyze_email with artifact_ref "<id>".]` (the bytes are never inlined; the model reaches them only through `analyze_email`, whose `loadArtifact` reads `ctx.tenantId` and refuses image artifacts)
  - `[Attached image: <filename> (image, <size>), id "<id>".]` followed by `{ type: "image", source: { type: "base64", media_type, data } }`

  The UI parses the notes back (`parseAttachmentNote` in `lib/attachments.ts`) into thumbnails (`/api/artifacts/<id>?inline=1`) and file chips. A verdict from a turn with attachments gets `raw_ref` = the first attachment id (when the model did not set one) and is saved with `artifactId`.
- `GET /api/health` also returns `artifacts: "ok" | "memory" | "unconfigured"`: `unconfigured` when `NEO_MASTER_KEY` is missing on `VERCEL_ENV=production` or with a database outside `MOCK_MODE`, or when `BLOB_READ_WRITE_TOKEN` is missing on a deployment outside `MOCK_MODE`; `memory` = in-memory blob client (no token; MOCK_MODE / local); `ok` otherwise.
- Without `DATABASE_URL`, artifacts use an in-memory store (per process, plaintext) like the other no-database fallbacks.
- `@neo/core` context manager (shipped): image blocks count 1600 tokens; past the compression trigger, images before the latest user turn are replaced by `[image omitted]` text blocks first, and Haiku compression runs only if that is not enough. `omitOlderImages` and `IMAGE_OMITTED_TEXT` are exported from `context-manager.ts` (not from the package index).
