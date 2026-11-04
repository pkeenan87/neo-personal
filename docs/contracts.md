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
  | { type: "error"; message: string }
  | { type: "verdict_override"; verdict: Verdict };   // sign-in alerts: sent by the server AFTER `done` when a rule replaced the verdict the model streamed; no signin_check
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
- Desktop tokens (shell / native clients, `_specs/desktop-auth.md`): `GET|POST /api/settings/desktop-tokens` need a browser session (403 `browser_session_required` for a desktop token); `DELETE ?id=` also accepts a desktop token for its own id. Issued tokens authenticate any API via `Authorization: Bearer neo_dt_…` and resolve to the same `{ userId, tenantId, role }` as a browser session plus `desktopTokenId`. Token plaintext is shown once; only the SHA-256 hash is stored (`desktop_tokens`, migration `0005`).
- Desktop sign-in (device authorization, migration `0006`): `POST /api/desktop/device { clientName? }` (no auth, 10/h per IP) → 201 `{ deviceCode, userCode, verificationUri, verificationUriComplete, expiresIn, interval }`; `POST /api/desktop/device/approve { userCode, approve }` (browser session, 20 per 10 min per user) → `{ status, clientName }`, 404 `not_found`, 409 `already_decided`; `POST /api/desktop/device/token { deviceCode }` (no auth, 60/min per IP) → 202 `{ status: "pending", interval }`, 200 `{ status: "approved", token, tokenId, clientName, email, name }` once (the token is minted at redemption and the request deleted), 403 `denied`, 410 `expired`, 404 `not_found`, 400 `token_limit`. Page `/desktop/authorize?code=`. `requireSession(returnTo)` redirects to `/?signin=required&next=<path>`; the landing page passes a same-origin `next` to Auth.js as the callback.

### Verdicts in chat

The system prompt (`apps/web/lib/server/system-prompt.ts`) tells the model to end every analysis with exactly one fenced block whose info string is `verdict` and whose body is a `Verdict` JSON object (schema from `verdictJsonSchema`). The UI renders it as a verdict card (`lib/verdict-fence.ts`); the route validates the block in the final assistant message with `VerdictSchema` and inserts a `verdicts` row. The block is prose-embedded rather than a structured-output call so one streamed turn carries both the explanation and the verdict.

### Modes

- `MOCK_MODE=true`: the real agent loop runs against a scripted offline model (`lib/server/mock-model.ts`, passed as `client`), `check_url` runs in @neo/tools mock mode, and a destructive demo tool `report_phish_demo` is registered (send a message containing `confirm-test`) to exercise the confirmation gate. No API key or network needed.
- No `DATABASE_URL`: conversations, usage, audit events and verdicts use in-memory fallbacks (per process), and no sign-in provider is registered; only `DEV_AUTH_BYPASS` signs in (fixed in-memory dev tenant). For local demos and CI only.
- `DEV_AUTH_BYPASS=true` is honoured only when `NODE_ENV !== "production"` and `VERCEL_ENV` is neither `production` nor `preview`.

---

# Package contracts (Phase 1)

Additive to Phase 0, as shipped. Full behaviour lives in the specs under `_specs/`; the signatures below are authoritative.

## @neo/tools (spec `_specs/email-analysis.md`, `_specs/sms-analysis.md`)

```ts
export function parseEmail(raw: string | Uint8Array): Promise<ParsedEmail>;
export function analyzeEmail(input: EmailInput, opts?: { deps?: Partial<UrlAnalysisDeps>; signal?: AbortSignal; maxUrls?: number }): Promise<EmailAnalysis>;
export const analyzeEmailTool: RegisteredTool;                       // "analyze_email"; input { artifact_ref? | raw? | pasted? } (exactly one)
export function createAnalyzeEmailTool(opts?: { deps?: Partial<UrlAnalysisDeps>; loadArtifact?: (ref: string, ctx: ToolContext) => Promise<Uint8Array | undefined> }): RegisteredTool;
export const EMAIL_ANALYSIS_GUIDANCE: string;
export function extractEmailIocs(a: EmailAnalysis): Verdict["iocs"];
export function analyzeSms(input: SmsInput, opts?: { deps?: Partial<UrlAnalysisDeps>; signal?: AbortSignal; maxUrls?: number }): Promise<SmsAnalysis>;
export const analyzeSmsTool: RegisteredTool;                         // "analyze_sms"; input { sender?, body, received_at?, user_country? }
export function createAnalyzeSmsTool(opts?: { deps?: Partial<UrlAnalysisDeps> }): RegisteredTool;
export const SMS_ANALYSIS_GUIDANCE: string;
export function extractSmsIocs(a: SmsAnalysis): Verdict["iocs"];
export type { ParsedEmail, EmailInput, EmailAnalysis, SmsInput, SmsAnalysis };
```
Both tools are read-only, `strict: true`, never throw for analysis failures (`errors[]`), and never fetch attachments or render HTML. Mock mode: offline parsing plus the Phase 0 URL mock. `loadArtifact` receives the `ToolContext` and must scope by `ctx.tenantId`.

Notes:
- `execute` throws (zod) only for invalid input: not exactly one of `artifact_ref`/`raw`/`pasted`, `raw` over 512 KB (UTF-8 bytes), SMS `body` over 4000 chars, `user_country` not two letters. `null` for an optional field is treated as absent. Artifact problems are results, not throws: `errors: ["artifact_not_found"]` (loader returned `undefined`), `["artifact_load_failed"]` (loader threw; logged with `tenantId` only), `["artifact_store_unavailable"]` (no loader: the default `analyzeEmailTool`). apps/web must register `createAnalyzeEmailTool({ deps, loadArtifact })`, with `loadArtifact = (ref, ctx) => artifactStore.read(ref, ctx.tenantId)` (return `undefined` for other tenants' ids and for `image` artifacts). `eml`/`inbound_eml` bytes are parsed as MIME; bytes with no recognizable message headers (a `text` artifact) are analyzed as a pasted body (`input_kind: "raw"`, `headers_present: false`).
- Other analyzer errors: `unsupported_format` (OLE/.msg), `parse_failed`, `empty_input`, `truncated: ...` (message > 4 MB or HTML > 512 KB was cut), `virustotal_file: ...`, SMS `urls_truncated: ...`.
- `analyzeEmail` options also take `maxUrls` (default 8, hard cap 8); `analyzeSms` takes `maxUrls` (default 5, hard cap 5; at most 5 URLs listed). Email lists at most 50 URLs (duplicates are merged, not listed; `skipped: "duplicate"` is never emitted) and 50 attachments; strings are capped at 2048 chars, `text_excerpt` at 2000, `body_excerpt` at 1000. `analyzed_at` is fixed (`2026-01-15T12:00:00.000Z`) in mock mode.
- `EmailAnalysis` also has `phone_numbers` (callback numbers, E.164 when parseable), `authentication.compauth` (Microsoft), and per attachment `extension` and `flags` (`ole_document`, `archive_not_inspected`, `macro_enabled`, `rtlo_in_name`, `inline`); attachment `virustotal` is a file report (`GET /files/{sha256}`, lookup only, at most 5 per message) or `{ status: "not_found" }` or `{ skipped: "no_api_key" | "mock" | "limit" | "not_applicable" | "error" }`. `ParsedEmail` adds `fromCount`, `headersSynthetic`, `truncated`.
- Heuristic catalogs with descriptions: `EMAIL_HEURISTIC_CODES`, `SMS_HEURISTIC_CODES`. Codes beyond the spec lists: email `missing_from`, `multiple_from`, `unicode_tricks_in_display_name`, `display_name_address_mismatch`, `spf_softfail`, `url_reputation_flagged`, `url_brand_lookalike`, `url_non_web_scheme`, `many_urls`, `ole_document`, `archive_not_inspected`, `callback_number_present`; SMS `reply_to_activate_link`, `group_message`, `non_english_body`, `link_only_message`, `first_seen_domain_lt_30d`, `url_reputation_flagged`, `url_brand_lookalike`.
- Also exported: `createAnalyzeSmsTool`/`createAnalyzeEmailTool` definitions and zod schemas (`analyzeEmailDefinition`, `AnalyzeEmailInputSchema`, `analyzeSmsDefinition`, `AnalyzeSmsInputSchema`), `emailErrorResult`, `parsePasted`, `detectMagic`, `EmailParseError`, `evaluateAuthentication`, `parseAuthResultsValue`, `analyzeHtml`, `triageAttachment`, `checkVirusTotalFile`, `classifySmsSender`, `stripChrome`, `parsePhone`, `extractPhoneNumbers`, `extractTextUrls`, `refang`, `isFreeMailDomain`.
- Data tables that can grow without code changes live in `packages/tools/src/data/` (`sms-lures.json`, `email-signals.json`, `injection-patterns.json`, `free-mail-providers.json`, `dangerous-extensions.json`, `country-calling-codes.json`, `nanp-area-codes.json`). New runtime dependency: `postal-mime` 3.0.0. No new env vars (`VIRUSTOTAL_API_KEY` is reused).
- Logging: one `info` line per analysis; metadata `labels` (heuristic codes), `spf`, `dkim`, `dmarc`, `urlCount`, `attachmentCount`, `senderDomain` (the analyzed sender's registrable domain) for email, `kind` (sender type) and `urlCount` for SMS. Never subjects, addresses or bodies.
- Result size: an `analyze_email` result with 8 URL analyses measured about 15 KB of JSON (~4.4k estimated tokens) with mock URL reports; real reports are larger but stay well under `NEO_TOOL_RESULT_MAX_TOKENS` (default 25000), which truncates anything bigger when it enters the model.

## @neo/core (spec `_specs/intake.md`, `_specs/forward-to-address.md`)

```ts
// Artifact crypto (pure; AES-256-GCM, HKDF per tenant, AAD = artifact id)
export function masterKeyFromEnv(source?: NodeJS.ProcessEnv): Uint8Array | undefined;   // NEO_MASTER_KEY base64 (32 bytes)
export function deriveTenantKey(masterKey: Uint8Array, tenantId: string): Uint8Array;
export function deriveKey(masterKey: Uint8Array, label: string, context: string): Uint8Array; // HKDF-SHA256 with the shared fixed salt; info is label plus optional context; 32 bytes
export function encryptArtifact(key: Uint8Array, plaintext: Uint8Array, aad: string): Uint8Array;
export function decryptArtifact(key: Uint8Array, blob: Uint8Array, aad: string): Uint8Array;  // throws ArtifactDecryptError
export class ArtifactDecryptError extends Error {}

// Bulk triage: one structured-output call on NEO_TRIAGE_MODEL (default claude-sonnet-5), effort low.
// `client` is an AI SDK text caller, not an Anthropic SDK client. See ModelTextClient below.
export type ModelTextClient = (call: ModelTextCall) => Promise<ModelTextResponse>;
export function runTriage(input: { evidence: unknown; evidenceKind: "email" | "sms"; guidance: string; client?: ModelTextClient; model?: string; signal?: AbortSignal; maxTokens?: number }): Promise<{ verdict: Verdict; usage: AgentUsage; model: string; attempts: number; fallback: boolean }>;
export const TRIAGE_SYSTEM_PROMPT: string;
export function triageModel(): string;                                                   // NEO_TRIAGE_MODEL

// Context manager: image blocks count 1600 tokens; past the compression trigger, images before the latest
// user turn become "[image omitted]" text blocks first, and Haiku compression runs only if that is not enough.
export const IMAGE_OMITTED_TEXT: string;
export function omitOlderImages(messages: readonly MessageParam[]): { messages: MessageParam[]; omitted: number };
```

Notes:
- `masterKeyFromEnv` accepts standard or URL-safe base64, returns `undefined` when unset/blank, and **throws** when set but not 32 bytes. HKDF uses a fixed salt (`neo-artifact-hkdf-salt-v1`) plus info `neo-artifact-v1:<tenantId>`. Also exported: `ARTIFACT_CIPHERTEXT_OVERHEAD` (32 bytes).
- `runTriage` returns `{ verdict, usage, model, attempts, fallback }` (`fallback: true` = the `triage_failed` verdict). It takes `maxTokens?` (default 4096, not 2048: adaptive thinking shares the budget with the verdict). The call is AI SDK 7 `generateText` (`generateModelText`): one user `prompt`, no assistant prefill, no tools. `output: Output.object({ schema: jsonSchema(verdictJsonSchema) })` with `providerOptions.anthropic.structuredOutputMode: "outputFormat"`. Models with adaptive thinking (Sonnet 5) also send `providerOptions.anthropic.thinking: { type: "adaptive" }` and `providerOptions.anthropic.effort` (`low`, then `medium` on retry). Haiku 4.5 sends neither thinking nor effort. Never `budget_tokens`. The system text keeps an ephemeral Anthropic cache breakpoint. The loose `verdictJsonSchema` is what the model sees; `VerdictSchema` still validates the result and `subject_type` is forced to `evidenceKind`. Refusal (`finishReason: "content-filter"`) / truncation (`length`) / invalid JSON / schema mismatch → one retry at `medium` → fallback. `NoObjectGeneratedError` counts as a failed attempt (usage included) and is not rethrown. Other errors are thrown (so Inngest retries). Gateway on: `providerOptions.gateway` is `gatewayProviderOptions` (ZDR, US region unless `NEO_GATEWAY_REGION=global`, provider order, catalog fallbacks) and the model is the gateway slug string. Gateway off: `@ai-sdk/anthropic` with the direct model id and no `providerOptions.gateway`. Without `client`, `MOCK_MODE=true` uses `createMockTriageClient()` (verdict from analyzer heuristic codes). `client?: ModelTextClient` replaces the old Anthropic client injection.
- `ModelTextCall` / `ModelTextResponse` / `ModelTextClient` (`packages/core/src/model-text.ts`) are the injected caller. `generateModelText(call)` is the default. `buildTriageRequest` returns a `ModelTextCall` (not Anthropic `MessageCreateParams`). `parseTriageResponse(response, kind)` reads a `ModelTextResponse` (`finishReason`, `text`, `output`, `invalidObject`).
- Also exported: `DEFAULT_TRIAGE_MODEL`, `DEFAULT_TRIAGE_MAX_TOKENS`, `buildTriageRequest`, `parseTriageResponse`, `triageFailedVerdict`, `createMockTriageClient`, `generateModelText`, types `RunTriageInput`, `TriageResult`, `TriageEvidenceKind`, `ModelTextCall`, `ModelTextClient`, `ModelTextResponse`. `@neo/core` depends on `@neo/verdict`, `ai` 7.0.150 and `@ai-sdk/anthropic` 4.0.87 (direct mode only).
- `SAFE_METADATA_FIELDS` adds `inboundMessageId`, `verdictId`, `artifactId`, `addressId`, `senderDomain`, `spf`, `dkim`, `dmarc`, `urlCount`, `attachmentCount`, `status`, `kind`, `source`, `playbook`, `artifactsPurged`, `artifactErrors`, `inboundRowsDeleted` (`effort` was already allowed).

## @neo/db (specs `_specs/intake.md`, `_specs/forward-to-address.md`, `_specs/dashboard.md`)

Migration `0003_phase1` (additive; run as the owner before deploying): `artifacts` + `filename`, `mime_type` (backfilled), `source` (`upload|inbound`, checked); `verdicts` + `source` (`chat|inbound|api`, default `chat`), `artifact_id` (FK, `on delete set null`), indexes; new `inbound_addresses` (unique `local_part`, one active address per tenant) and `inbound_messages` (unique `provider_message_id`, status check, FKs to artifacts/verdicts `on delete set null`), both with the `tenant_isolation` RLS policy and in `tenantTables`. Three `security definer` functions, `EXECUTE` revoked from `PUBLIC` and granted to `app_user` (in the migration when the role exists, else by `sql/create-app-user.sql`): `resolve_inbound_address(text)`, `list_expired_artifacts(integer)`, `purge_old_inbound_messages(integer)` (see `packages/db/docs/rls.md`).

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
  listExpired(limit: number): Promise<ArtifactMeta[]>;                  // across tenants, via list_expired_artifacts()
  purge(id: string, tenantId?: string): Promise<void>;                  // app role: pass the tenantId from listExpired()
}
export function createArtifactStore(db: Db, opts: { blob: BlobClient; masterKey?: Uint8Array; retentionDays?: number; allowPlaintext?: boolean; now?: () => Date }): ArtifactStore;
export class ArtifactStoreUnavailableError extends Error {}           // put() without a key and without allowPlaintext → 503

export const inbound: {
  ensureAddress(db, tenantId): Promise<{ id: string; localPart: string; address: string | null }>;   // address null without NEO_INBOUND_DOMAIN
  rotateAddress(db, tenantId): Promise<{ id: string; localPart: string; address: string | null }>;
  findActiveByLocalPart(db, localPart): Promise<{ id: string; tenantId: string } | undefined>;  // via resolve_inbound_address()
  recordMessage(db, input: { tenantId; addressId; providerMessageId; fromAddressHash; status: InboundStatus; error? }): Promise<{ id: string; duplicate: boolean }>;
  updateMessage(db, id, tenantId, patch: Partial<{ status: InboundStatus; forwarderUserId; artifactId; verdictId; error; completedAt }>): Promise<void>;
  getMessage(db, id, tenantId): Promise<InboundMessageRow | undefined>;
  countRecent(db, tenantId, addressId, windowMs): Promise<number>;
  listRecent(db, tenantId, limit?): Promise<InboundMessageRow[]>;                       // newest first, limit ≤ 100
  findByVerdictId(db, tenantId, verdictId): Promise<InboundMessageRow | undefined>;
  purgeOld(db, olderThanDays?): Promise<number>;                                        // rejected/failed rows, all tenants, via purge_old_inbound_messages()
};
export type InboundStatus = "received" | "analyzing" | "done" | "rejected" | "over_cap" | "failed";
export function generateLocalPart(): string;                            // "check-" + 12 lowercase Crockford base32 chars
export function isInboundLocalPart(s: string): boolean;
export function inboundAddressFor(localPart: string, env?): string | null;

export const verdictQueries: {
  list(db, tenantId, opts: { userId?; label?; subjectType?; source?; cursor?; limit? }): Promise<{ items: VerdictRow[]; nextCursor?: string }>;  // throws InvalidCursorError
  get(db, tenantId, id): Promise<VerdictRow | undefined>;
  summary(db, tenantId, opts: { userId?; sinceDays: 7 | 30 | 90 }): Promise<VerdictSummary>;
  remove(db, tenantId, id): Promise<boolean>;
};
export function saveVerdict(db, input: { tenantId; userId; conversationId?: string | null; artifactId?: string | null; source: "chat" | "inbound" | "api"; verdict: Verdict }): Promise<{ id: string }>;  // throws
export function listMembers(db, tenantId): Promise<{ userId; name: string | null; email: string | null; role: "owner" | "member" }[]>;
export function getHouseholdName(db, tenantId): Promise<string | undefined>;   // tenants is keyed by id (no tenant_id column)
```

Notes:
- `ArtifactStore.get` / `read` treat expired artifacts as missing. `put` without a master key throws `ArtifactStoreUnavailableError` unless `allowPlaintext` (ignored when `VERCEL_ENV=production`). `retentionDays` defaults to `NEO_ARTIFACT_RETENTION_DAYS` (30). Also exported: `artifactBlobPath`, `artifactRetentionDays`, `DEFAULT_ARTIFACT_RETENTION_DAYS`, types `PutArtifactInput`, `ArtifactStoreOptions`, `ArtifactSource`.
- `inbound.countRecent` is tenant-scoped (the webhook has the tenant from `findActiveByLocalPart`). `recordMessage` is idempotent on `providerMessageId` and bumps the address's `last_used_at`. `findActiveByLocalPart` lowercases/trims and returns undefined for anything not shaped like `check-<12 crockford>` without querying.
- `saveVerdict` validates with `VerdictSchema` (throws on invalid), sets `raw_ref` from `artifactId` when absent, and throws on DB errors (callers that must not fail catch). `verdictQueries.list` throws `InvalidCursorError` on a malformed cursor (route → 400); the cursor carries microsecond precision. `summary` covers whole UTC days (today and the previous `sinceDays - 1`), `perDay` has one entry per day (zero-filled), `topIndicators` / `topDomains` count verdicts (not occurrences), domains lowercased; it also takes `now?` and `viewerUserId?`: `topIndicators` / `topDomains` include a `signin_alert` verdict only when its user is the viewer (no viewer: none). `remove` does not delete the linked artifact (the app does, via `ArtifactStore.delete`). Types exported: `VerdictRow` (`body: Verdict`), `VerdictSummary`, `VerdictListOptions`, `HouseholdMember`, `InboundMessageRow`, `InboundStatus`, `VerdictSource`, `ArtifactKind`.
- New tables are in `tenantTables`.

## apps/web

Routes added: `POST /api/artifacts`, `GET /api/artifacts/[id]`, `POST /api/inbound/resend`, `GET|POST|PUT /api/inngest`, `GET /api/verdicts`, `GET /api/verdicts/summary`, `GET|DELETE /api/verdicts/[id]`, `GET /api/household`, `GET|POST /api/settings/forwarding` (POST = rotate). Pages: `/dashboard` (where `/` sends signed-in users), `/verdicts/[id]`, `/settings/forwarding`; every signed-in page outside the chat uses `AppShell` (nav: Dashboard, Chat, Settings), and the chat sidebar links to Dashboard and Settings.
Tool registry: `check_url`, `createAnalyzeEmailTool({ deps: { cache }, loadArtifact: loadArtifactForTool })`, `createAnalyzeSmsTool({ deps: { cache } })` (+ the MOCK_MODE demo tool), sharing one URL reputation cache with the inbound job. `loadArtifactForTool(ref, ctx)` reads through the app artifact store with `ctx.tenantId` and returns `undefined` for malformed, foreign, expired and `image` artifacts. The system prompt (byte-stable) adds `INTAKE_GUIDANCE`, `EMAIL_ANALYSIS_GUIDANCE`, `SMS_ANALYSIS_GUIDANCE` and `## Incident playbooks`.
Inngest: client `apps/web/inngest/client.ts` (id `neo`), functions `email-received` (event `neo/email.received`) and `artifacts-expire` (cron `0 4 * * *`). `MOCK_MODE` without `INNGEST_EVENT_KEY` runs `email-received` inline from the webhook.

Server wiring (one of each):
- **Artifact store**: `getArtifactStore()` in `lib/server/artifacts.ts`, used by uploads, `/api/agent` attachments, `analyze_email`, the inbound job, the dashboard and the retention job. With a database: `createArtifactStore(db, { blob: createVercelBlobClient(BLOB_READ_WRITE_TOKEN) or createMemoryBlobClient(), masterKey: masterKeyFromEnv(), allowPlaintext: no key })`, where a missing key is tolerated only in MOCK_MODE; without a database: an in-memory store. Returns null (routes answer 503 `storage_unavailable`) when `artifactsStatus()` is `unconfigured`.
- **Verdicts**: `saveVerdict()` in `lib/server/verdicts.ts` → `@neo/db` `saveVerdict` with a database, else the shared in-memory rows. Chat verdicts are saved with `source: "chat"` (`saveChatVerdict`, never throws; `artifactId` = first attachment), inbound verdicts with `source: "inbound"`, `conversationId: null`, `artifactId` = the forwarded `.eml`.
- **No-database state**: `lib/server/memory-state.ts` holds verdicts, household members and inbound addresses/messages for MOCK_MODE and tests (`resetMemoryState()`), so an inbound verdict appears on `/dashboard` and `/verdicts/[id]` with zero infrastructure.

Env added (all listed in `.env.example`, all optional locally): `BLOB_READ_WRITE_TOKEN`, `NEO_MASTER_KEY`, `NEO_ARTIFACT_RETENTION_DAYS`, `NEO_INBOUND_DOMAIN`, `RESEND_WEBHOOK_SECRET`, `RESEND_API_KEY` (defaults to `AUTH_RESEND_KEY`), `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`, `NEO_INBOUND_RATE_LIMIT_PER_HOUR`.

### HTTP contract: intake (`_specs/intake.md`)

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
- `GET /api/artifacts/[id]` is the only artifact URL: plain = download (`attachment`), `?inline=1` = display an image. The chat thumbnails and the verdict detail page's evidence both use it.

### HTTP contract: forward-to-address (`_specs/forward-to-address.md`)

- `POST /api/inbound/resend` (Resend `email.received` webhook, unauthenticated; Svix-signed with `RESEND_WEBHOOK_SECRET`). 401 `invalid_signature`; 503 `inbound_unconfigured` when the secret is unset (MOCK_MODE local bypass: header `x-neo-mock-inbound: 1`, localhost URL, not a deployment; the mock payload may carry `data.raw` for the mock Resend client); 413 `too_large` (body > 512 KB); 400 `bad_request`; 503 `storage_unavailable` (lookup/insert failed, Resend retries). 200 bodies: `{ ignored: true }` (other event types; no recipient in `received_for` ∪ `to` ∪ `cc` that is `check-<12 Crockford>@NEO_INBOUND_DOMAIN` and active), `{ duplicate: true }` (repeated `email_id`), `{ accepted: true }` (row inserted; over `NEO_INBOUND_RATE_LIMIT_PER_HOUR` the row is `rejected` with `error: "rate_limited"` and no job). If `inngest.send` fails the row becomes `failed` / `queue_unavailable`.
- Event `neo/email.received` data: `{ inboundMessageId: string; tenantId: string; emailId: string }` (`emailId` = Resend `email_id` = `provider_message_id`; added so the job needs no extra row lookup).
- Inngest function `email-received`: `retries: 3`, `concurrency: { limit: 5, key: "event.data.tenantId" }`, `timeouts: { finish: "4m" }`, `onFailure` → `failed` / `job_failed` + "could not analyze" email when the forwarder is known. Steps: `fetch-raw`, `store-artifact`, `identify-forwarder`, `check-caps`, `analyze`, `triage`, `save-verdict`, `notify` (one of the last two branches per run). Logic: `apps/web/lib/server/inbound/email-received-job.ts` (`runEmailReceived(data, deps, step)`; tests pass `inlineSteps`). `inbound_messages.error` codes: `unknown_sender`, `rate_limited`, `too_large`, `storage_unavailable`, `no_members`, `job_failed`, `queue_unavailable`, `gmail_confirmation:<digits>`, `gmail_confirmation_unparsed`.
- Inngest function `artifacts-expire`: cron `0 4 * * *`, steps `purge-artifacts` (`for (const m of await store.listExpired(200)) await store.purge(m.id, m.tenantId)`), `purge-inbound-rows` (`inbound.purgeOld(db, 90)`: rejected/failed rows older than 90 days, all tenants).
- `GET|POST|PUT /api/inngest` (`serve` from `inngest/next`, `maxDuration` 300 in `apps/web/vercel.json`). Client id `neo`.
- `GET /api/settings/forwarding` → `ForwardingSettings` (`apps/web/lib/forwarding-types.ts`): `{ address | null, localPart, configured, acceptedSenders[], canRotate, gmailConfirmation: { code, receivedAt } | null (owner only), messages: [{ id, status, reason, receivedAt, completedAt, verdictId }] }` (last 20). `POST` `{ action: "rotate" }` → same body with the new address; 403 `forbidden` for non-owners; 400 `bad_request`.
- `GET /api/health` adds `inbound: "ok" | "unconfigured"` (ok = domain, webhook secret, Resend key, Inngest event + signing keys all set).
- Notifications: `renderVerdictEmail(verdict, { detailUrl, forwardedSubject, usage? })` and `renderNoticeEmail(kind, …)` in `apps/web/lib/server/email/verdict-email.ts`; sent with the Resend REST API (`Idempotency-Key: verdict-<id>` / `inbound-<messageId>-<kind>`), recorded by a mock mailer in MOCK_MODE (`memorySentEmails()`).
- Audit events added: `inbound.rejected_unknown_sender`, `inbound.address_rotated`, `inbound.gmail_forwarding_confirmation`.
- Persistence goes through `inboundRepo()` (`lib/server/inbound/repo.ts`): `@neo/db` `inbound` with a database, else `lib/server/inbound/memory.ts` over the shared memory state. The webhook flow is `findActiveByLocalPart → countRecent(tenantId, addressId, 1 h) → recordMessage` (`duplicate` → 200 `{ duplicate: true }`).

### HTTP contract: dashboard and playbooks (`_specs/dashboard.md`, `_specs/incident-playbooks.md`)

Wire types: `apps/web/lib/dashboard-types.ts`. All routes: Node runtime, `force-dynamic`, `Cache-Control: no-store`, JSON errors `{ error, code? }`, 401 `unauthenticated` without a session, 503 `storage_unavailable` when the store fails. Role rule everywhere: members are pinned to their own `userId`; owners see the whole household or filter by a current member.

- `GET /api/verdicts?label&subjectType&source&userId&cursor&limit` → `{ items: [{ id, subjectType, verdict, confidence, headline, source, createdAt, userId, conversationId, artifactId }], nextCursor: string | null }`. Newest first; `limit` 1..50 (default 20); `cursor` is the opaque keyset cursor from the previous page (`base64url(createdAt ISO|id)`). 400 `bad_request` for an unknown `label`/`subjectType`/`source`, a bad `limit` or cursor; 403 `forbidden` when a member passes another user's `userId`; 404 `not_found` when an owner passes a user who is not in the household.
- `GET /api/verdicts/summary?sinceDays=7|30|90&userId` (default 30) → `{ sinceDays, total, byLabel, bySubjectType, topIndicators: [{ category, count }] (top 8), topDomains: [{ domain, count }] (top 8, excluding likely_safe), perDay: [{ day: "YYYY-MM-DD", malicious, suspicious, likely_safe, insufficient_evidence }] }` (zero-filled per UTC day with a database; the in-memory fallback may be sparse and the UI zero-fills). Same 400/403/404 rules.
- `GET /api/verdicts/[id]` → list item fields + `body: Verdict`, `conversation: { id, title } | null`, `artifact: { id, kind, filename, mimeType, sizeBytes, expiresAt, expired } | null`, `inbound: { status, receivedAt, forwardedBy } | null` (looked up with `inbound.findByVerdictId`), `memberName`. `artifact` is null once the evidence expired or was deleted (the page says so). 404 `not_found` for malformed ids, other tenants' verdicts and, for members, other members' verdicts.
- `DELETE /api/verdicts/[id]` → 204 for the owner or the member the verdict belongs to (404 otherwise); deletes the linked artifact (`ArtifactStore.delete`) and writes audit event `verdict.deleted` `{ verdictId, ownerUserIdHash, artifactId, artifactDeleted }`.
- `GET /api/household` → `{ tenantId, name, role, members: [{ userId, name, email, role }] }`; `name` from `getHouseholdName` ("Your household" without a database); `email` is `null` for every member unless the caller is an owner.
- `POST /api/agent` body also takes `playbook?: PlaybookId` (400 when unknown) and `verdictId?: string` (400 malformed, 404 when not visible to the caller). `playbook` runs the turn with `effort: "high"`; effort also stays `high` for the turn after an assistant turn whose text starts with `<!-- playbook:<id> -->` (the UI hides the marker). `verdictId` makes the server load the stored verdict (tenant + role scoped) and append it to the user message as a second text block, prefixed `[neo:context]` and wrapped with `wrapToolResult("stored_verdict", …)`; the chat UI hides that block on reload.
- `PlaybookId` = `clicked_link | entered_password | sent_gift_cards | shared_code | paid_scammer | device_compromised` (`apps/web/lib/playbooks.ts`). Playbook text: `apps/web/lib/server/playbooks/*.md`, bundled into `generated.ts` (`pnpm --filter @neo/web playbooks:generate`; a test fails when stale) and included in the system prompt under `## Incident playbooks`.
- Pages: `/dashboard`, `/verdicts/[id]`; `/` redirects signed-in users to `/dashboard`. Chat entry points: `/chat?playbook=<id>` (auto-sends "I think I …. Help me." with `playbook`), `/chat?verdict=<id>` (auto-sends "Tell me more about this check: …" with `verdictId`), `/chat?check=<url>` (pre-fills the composer only). Evidence links: `GET /api/artifacts/<id>?inline=1` for image display, plain `GET /api/artifacts/<id>` to download.

# Package contracts (Phase 2)

Plan `_plans/phase-2-model-routing.md`, spec `_specs/model-routing.md`. Everything below is additive to Phases 0 and 1. Model ids: with the gateway on, ids are gateway slugs (`anthropic/claude-haiku-4.5`, `anthropic/claude-sonnet-5`, `anthropic/claude-opus-5`, `openai/gpt-6-luna`, `openai/gpt-6-sol`, `openai/gpt-6-astra`, `moonshotai/kimi-k3`, `spacexai/grok-4.1-fast-reasoning`, `spacexai/grok-4.7`, `spacexai/grok-4.6`); with the gateway off, the Phase 0 direct ids apply and only the Anthropic family is available.

## @neo/core (spec `_specs/model-routing.md`)

```ts
// Gateway client and request policy
export function gatewayEnabled(source?: EnvSource): boolean;                 // NEO_MODEL_GATEWAY=true && AI_GATEWAY_API_KEY
export function gatewayRegion(source?: EnvSource): "us" | "global";           // NEO_GATEWAY_REGION, default "us"
export function createModelClient(source?: EnvSource): Anthropic;            // baseURL https://ai-gateway.vercel.sh + AI_GATEWAY_API_KEY when enabled; else new Anthropic()
export function modelIdFor(model: CatalogModel, source?: EnvSource): string; // gateway id, or directId when the gateway is off
export function withGatewayOptions<T extends object>(params: T, model: CatalogModel, source?: EnvSource): T;  // adds providerOptions.gateway { zeroDataRetention: true, inferenceRegion, order, models? }; no-op when off

// Catalog and routing tables (pure, no I/O)
export type Tier = "small" | "medium" | "large";
export type RoutingPreference = "cost" | "balanced" | "intelligence";
export type ModelFamily = "anthropic" | "openai" | "kimi" | "grok";
export type RouterKind = "jev" | "rule" | "pinned";
export interface CatalogModel { id: string; directId?: string; displayName: string; family: ModelFamily; tier: Tier; efforts: readonly Effort[]; order: readonly string[]; regionOverrides?: Record<string, null>; fallbacks?: readonly string[]; pricing: { input: number; output: number } }
// fallbacks (added 2026-09-26): gateway model fallbacks sent as providerOptions.gateway.models; the large rungs fall back to the family's medium model
export function servedModelOf(message: { model?: string } & Record<string, unknown>): string | undefined; // provider_metadata.gateway.routing.canonicalSlug, else message.model
export interface RouteSignals { complexity?: number; stakes?: number; needsTools?: boolean; confidence?: number; reason?: string }
export interface Route { tier: Tier; family: ModelFamily; model: string; displayName: string; effort: Effort; preference: RoutingPreference; router: RouterKind; signals?: RouteSignals }
export const MODEL_CATALOG: Record<ModelFamily, Record<Tier, CatalogModel>>;
export const PREFERENCE_TABLE: Record<RoutingPreference, Record<Tier, { rung: Tier; effort: Effort }>>;
export const ROUTING_PREFERENCES: readonly RoutingPreference[]; export const MODEL_FAMILIES: readonly ModelFamily[]; export const TIERS: readonly Tier[];
export function resolveRoute(input: { tier: Tier; preference: RoutingPreference; family: ModelFamily; router: RouterKind; signals?: RouteSignals; source?: EnvSource }): Route;  // falls back to "anthropic" when the family is not enabled or the gateway is off
export function pinnedRoute(kind: "compression" | "triage" | "playbook", source?: EnvSource): Route;  // Haiku 4.5 low / Sonnet 5 low / Opus 5 high
export function clampEffort(model: CatalogModel, effort: Effort): Effort;    // nearest listed level, higher on ties
export function displayNameFor(modelId: string): string;                    // catalog display name, else the id
export function enabledFamilies(source?: EnvSource): ModelFamily[];         // NEO_MODEL_FAMILIES (comma list), default ["anthropic"]; "anthropic" is always included

// Agent loop additions
export type AgentEvent = /* Phase 0 events */
  | { type: "route"; model: string; displayName: string; tier: Tier; effort: Effort; family: ModelFamily; preference: RoutingPreference; router: RouterKind; reason?: string }
  | { type: "usage"; input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; model?: string };
export interface RunAgentOptions { /* Phase 0 */ route?: Route }             // sets model + effort; emitted first as the `route` event
export interface AgentResult { /* Phase 0 */ servedModel?: string }          // `message.model` of the last response
```
- Env: `NEO_MODEL_GATEWAY`, `AI_GATEWAY_API_KEY`, `NEO_GATEWAY_REGION`, `NEO_MODEL_FAMILIES`, `NEO_MODEL_SMALL`, `NEO_MODEL_MEDIUM`, `NEO_MODEL_LARGE` (override the Anthropic ladder; direct or gateway form). `NEO_AGENT_MODEL`, `NEO_TRIAGE_MODEL`, `NEO_COMPRESSION_MODEL`, `NEO_ENABLE_FALLBACKS` keep their Phase 0 meaning; on the gateway the refusal-fallback beta is sent only when `NEO_ENABLE_FALLBACKS=true` is explicit.
- `agent.ts` still obtains its client from `createModelClient()` (Anthropic SDK). An injected `client` still wins for the chat loop.
- Triage does not use that client. It calls `generateModelText` (AI SDK `generateText`). See the Phase 1 triage note for the request shape.
- Compression (`prepareMessages`) builds one text call from `pinnedRoute("compression")` (Haiku 4.5, no thinking, no effort, no `budget_tokens`, `maxOutputTokens` 4096) and `gatewayProviderOptions` when the gateway is on. A hashed `userId` is `providerOptions.anthropic.metadata.userId`. The caller is `generateModelText` (`generateText`). `PrepareMessagesOptions.generate?: ModelTextClient` overrides it (tests). In `MOCK_MODE`, an injected `client?: Anthropic` (the live chat loop's scripted demo client) is still used via `messages.create`, and that shim sends `metadata.user_id`. History passed through `prepareMessages` stays `MessageParam`; replacing that type is not part of this change.

## @neo/db (spec `_specs/model-routing.md`)

```ts
// migration 0004_model_routing
memberships.routing_preference text not null default 'balanced'  check in ('cost','balanced','intelligence')
memberships.model_family       text not null default 'anthropic' check in ('anthropic','openai','kimi','grok')
turns.route                    jsonb            // Route
usage_events.tier              text             // 'small' | 'medium' | 'large' | null

export interface MemberPreferences { routingPreference: RoutingPreference; modelFamily: ModelFamily }
tenantScoped(db, tenantId).memberships.getPreferences(userId): Promise<MemberPreferences>;             // defaults when the row has none
tenantScoped(db, tenantId).memberships.setPreferences(userId, patch: Partial<MemberPreferences>): Promise<MemberPreferences>;
ConversationStore.appendTurn(id, tenantId, { messages; usage?; pendingConfirmation?; route?: Route }): Promise<void>;
ConversationStore.get(id, tenantId): Promise<{ id; messages; pendingConfirmation?; lastRoute?: Route } | undefined>;
usage.recordCheck(db, { /* Phase 0 + 1 */ tier?: Tier });
```

## apps/web (spec `_specs/model-routing.md`)

```ts
// lib/server/router.ts
export interface RouteTurnInput { text: string; hasAttachment: boolean; attachmentKind: "email" | "image" | "text" | null; priorTurns: number; previousVerdict: VerdictLabel | null; playbook: PlaybookId | null; preference: RoutingPreference; family: ModelFamily; signal?: AbortSignal }
export function routeTurn(input: RouteTurnInput, deps?: { evaluate?: EvaluateFn; now?: () => number }): Promise<Route>;
export function redactForRouting(text: string): string;
export function rulesTier(input: RouteTurnInput): Tier;
export function decideTier(answers: JevAnswers, confidence: Record<string, number> | undefined, needsToolsFloor: boolean): { tier: Tier; signals: RouteSignals };
```
- Jev: model `typesafe-ai/jev` through AI SDK 7 `experimental_evaluate`; questions `complexity` (score, 3 levels), `stakes` (score, 3 levels), `needs_tools` (boolean); `providerOptions.gateway.zeroDataRetention` = `NEO_ROUTER_ZDR !== "false"`; 1.5 s timeout; any failure → `rulesTier` with `router: "rule"`. `NEO_ROUTER=jev|rules|off` (default `jev` when the gateway is on, `rules` otherwise and in `MOCK_MODE`).
- `streamAgentRun` reads the member's preferences, calls `routeTurn`, passes `route`, persists it on the turn, records `usage_events.model` from `servedModel` (fallback the route's model) and `tier`. `/api/agent/confirm` reuses `lastRoute` (rules-routed when absent).
- `env.HAS_MODEL_CREDENTIALS` = Anthropic credentials, or `NEO_MODEL_GATEWAY=true` + `AI_GATEWAY_API_KEY`. `/api/agent` 503 `agent_unavailable` when false and not `MOCK_MODE`.

### HTTP contract: routing settings

- `GET /api/settings/routing` → 200 `{ preference, family, families: [{ id, label, enabled, caveat?, ladder: [{ tier, model, displayName, pricing: { input, output } }] }] }`. 401 `unauthenticated`.
- `POST /api/settings/routing` `{ preference?, family? }` → 200 same shape. 400 `bad_request` (unknown value, or a family not in `enabledFamilies()`), 401. Any member sets their own row.
- Page `/settings/routing` renders `RoutingSettings`; `AppShell` links it next to Forwarding.

### Chat events and UI

- `route` is the first event of a turn; `usage.model` carries the served model. `chat-state.ts` stores both on the assistant message (`ChatMessage.route`, `ChatMessage.servedModel`); `messagesFromStored` reads `turns.route`.
- `MessageActions` shows a chip `<displayName> · <tier> · <preference>` with a tooltip explaining the route (Jev signals, "Playbook", or "Fallback rule"). `MOCK_MODE` shows `neo-mock-model`.
- Gateway 402 `quota_for_entity_exceeded` → the existing user-safe error path with "Neo's monthly AI budget is used up. Please try again after it resets." and one `usage.budget_exhausted` audit event per tenant per day.

### Shipped additions and differences (Phase 2, as built)

- `@neo/core` also exports `createModelClient()`, `resetModelClientForTests()`, `gatewayProviderOptions(model, source)`, `withGatewayOptions(params, model, source)`, `requestShape(model, effort, { summarizedThinking? })` (the `thinking` / `output_config` fragments: Haiku 4.5 gets neither; no `budget_tokens` ever), `modelEntryFor(modelId)` (catalog entry, or a stand-in for unknown ids that keeps adaptive thinking and every effort level), `refusalFallbacksEnabled(source)` (direct mode: Phase 0 rule; gateway: only when `NEO_ENABLE_FALLBACKS` is explicitly truthy), `catalogModel`, `anthropicModelFor`, `catalogEntryFor`, `gatewayModelId`, `directModelId`, `BUDGET_EXHAUSTED_MESSAGE`, `isBudgetExhaustedError(err)` and `AI_GATEWAY_BASE_URL`. `AgentResult.errorCode?: "budget_exhausted"` is set when the gateway answered 402 / `quota_for_entity_exceeded`; the `error` event then carries `BUDGET_EXHAUSTED_MESSAGE`.
- With the gateway on and no `route`, `opts.model` / `NEO_AGENT_MODEL`, the triage `input.model` / `NEO_TRIAGE_MODEL` and the `compressionModel` option are converted to gateway slugs with `gatewayModelId`. `NEO_TRIAGE_MODEL` wins over `NEO_MODEL_MEDIUM` for triage; compression checks `NEO_MODEL_SMALL` before `NEO_COMPRESSION_MODEL`.
- `NEO_AGENT_EFFORT` no longer affects routed chat turns: the effort comes from the preference table (`RunAgentOptions.route`). It remains the fallback for a run without a route.
- `SAFE_METADATA_FIELDS` gained `tier`, `router`, `family`, `preference`, `gateway`.
- Router: `routeTurn(input, deps?: { evaluate?, now?, env? })` also takes `env` (read at call time; tests pass `NEO_ROUTER`, `NEO_MODEL_GATEWAY`, `AI_GATEWAY_API_KEY`). Extra exports: `JEV_MODEL`, `JEV_QUESTIONS`, `JEV_TIMEOUT_MS`, `EvaluateFn`, `JevAnswers`, `JevScoreAnswer`, `JevBooleanAnswer`. `NEO_ROUTER=off` routes with `signals.reason = "Router off"`; the Jev call uses `maxRetries: 0`; a malformed Jev answer falls back to rules. Redaction handles `http(s)://` and `www.` URLs (bare domains stay), keeps IPv4 hosts, masks phone numbers of 7+ digits, and uses a small hardcoded two-part public-suffix list.
- Web wiring (`lib/server/agent-run.ts`): `routeForTurn({ session, text, attachments, history, playbook?, signal? })` loads the member's preferences (`lib/server/routing-settings.ts`, in-memory without `DATABASE_URL`), derives `attachmentKind` from the first attachment (`eml` / `inbound_eml` → `email`), `priorTurns` from user messages that are not tool-result carriers, and `previousVerdict` with `extractVerdict(history)`. `routeForResume(session, history)` routes a resume whose stored turn has no route, rules only. `AgentRunInput.route?` overrides `effort`, is persisted on the turn and recorded with `usage_events.tier`; `usage_events.model` is the served model (`AgentResult.servedModel`, `neo-mock-model` in `MOCK_MODE`), falling back to the route's model. One `usage.budget_exhausted` audit event per tenant per UTC day, deduplicated per instance.
- Settings API errors follow the forwarding route: `{ error: <message>, code: "bad_request" | "unauthenticated" | "storage_unavailable" }`; a POST with neither field is a 400; a store failure is 503 `storage_unavailable`. `lib/routing-types.ts` holds the wire types; the page computes the preference → model list on the server (`preferenceModels()`) so `@neo/core`'s catalog stays out of the client bundle except `displayNameFor`. `AppShell` shows a Forwarding | Routing sub-navigation on settings pages.
- Chat state: `ChatEvent = AgentEvent`; `messagesFromStored` accepts `StoredMessage | StoredTurn` (`{ messages, route? }`) entries. `ConversationStore.get` returns only `lastRoute`, so after a reload only the most recent assistant message shows a chip (`lib/server/chat-data.ts`). `lib/ndjson.ts` validates the `route` event and `usage.model`. `MessageActions` exports `modelChip()`; the chip is `<span data-testid="model-chip">`.
- `.env.example` no longer sets `NEO_ENABLE_FALLBACKS=true` (unset means: on in direct mode, off on the gateway).

# Package contracts (Phase 3)

Plan `_plans/phase-3-household-devices.md`. Everything below is additive.

## @neo/db (spec `_specs/household-invites.md`)

Migration `0007_household_invites` (run as the owner before deploying): new `household_invites` (`kind` `email|link`, lowercased `email` required iff `kind = 'email'`, unique `token_hash` = SHA-256 of `neo_inv_` + 43 base64url chars, `token_prefix`, `send_count`, `invited_by`, `expires_at` (7 days), `accepted_by`, `accepted_at`, `revoked_at`) with the `tenant_isolation` RLS policy and in `tenantTables`; security-definer `lookup_household_invite(token_hash text) → (id, tenant_id)` for pending invites (`EXECUTE` granted to `app_user`); unique index `memberships_one_household` on `memberships(user_id)` replacing `memberships_user_idx` (the migration aborts if a user already has two memberships).

```ts
MAX_HOUSEHOLD_SIZE = 10;                // members + pending invites
HOUSEHOLD_INVITE_TTL_MS;                // 7 days
mintInviteSecret(); isInviteSecretFormat(s); hashInviteSecret(s); inviteSecretPrefix(s); normalizeInviteEmail(s): string | null;
createHouseholdInvite(db, { tenantId, invitedBy, kind, email?, now? })
  → { invite: HouseholdInvitePublic, secret } | { error: "invalid_email" | "already_member" | "invite_pending" | "household_full" };
listPendingHouseholdInvites(db, tenantId, now?) → HouseholdInvitePublic[];     // newest first
revokeHouseholdInvite(db, tenantId, inviteId, now?) → boolean;
rotateHouseholdInvite(db, tenantId, inviteId, now?) → { invite, secret } | { error: "not_found" };   // email invites only; bumps send_count
previewHouseholdInvite(db, { secret, userId, now? }) → InvitePreview | null;
acceptHouseholdInvite(db, { secret, userId, confirmLeave, now? })
  → { status: "accepted", inviteId, kind, tenantId, householdName, invitedBy, previousTenantId, orphanedBlobUrls }
  | { status: "not_found" | "email_mismatch" | "already_member" | "owns_household_with_members" | "already_in_household" | "confirm_required" };
removeHouseholdMember(db, { tenantId, userId, removedBy }) → { status: "removed" | "cannot_remove_owner", conversationsDeleted } | { status: "not_found" };
leaveHousehold(db, { tenantId, userId }) → { status: "left" | "owner_cannot_leave", conversationsDeleted } | { status: "not_found" };
```

Accepting deletes the user's one-person household (cascade) and returns its artifact blob URLs for the caller to delete after commit. Leaving or removal deletes the user's conversations in the household, keeps their verdicts, revokes their desktop tokens for the household and deletes their pending desktop sign-ins. Audit events written by `@neo/db`: `household.invite_accepted`, `household.member_removed`, `household.member_left`.

## apps/web

### HTTP contract: household (`_specs/household-invites.md`)

Wire types: `apps/web/lib/household-types.ts`. JSON errors `{ error, code }`. Every mutating route needs a browser session (403 `browser_session_required` for a desktop token); owner-only routes return 403 `forbidden` to members.

- `GET /api/household` adds `invites: HouseholdInviteItem[]` (`{ id, kind, email, tokenPrefix, createdAt, expiresAt, invitedByName }`), empty for members.
- `POST /api/household/invites { kind: "email", email } | { kind: "link" }` (owner) → 201 `{ invite, url }`; `url` is `<origin>/invite/<secret>`, returned once. 400 `invalid_email` | `household_full` | `bad_request`, 409 `already_member` | `invite_pending`, 429 `rate_limited` (20 per 24 h per tenant, shared with resend), 502 `email_failed` (the invite is revoked).
- `POST /api/household/invites/[id]/resend` (owner) → 200 `{ invite }`; new secret, new expiry, old link dead. 404 `not_found`.
- `DELETE /api/household/invites/[id]` (owner) → 204; 404 `not_found`.
- `DELETE /api/household/members/[userId]` (owner) → 204; 400 `cannot_remove_owner`, 404 `not_found`. Emails the removed member.
- `POST /api/household/leave` (member) → 204; 400 `owner_cannot_leave`.
- `GET /api/invites/[secret]` (any session) → `InvitePreviewResponse` `{ householdName, inviterName, kind, emailMatches, alreadyMember, currentHousehold: { name, role, memberCount, conversationCount, verdictCount, hasForwardingAddress } | null }`; 404 `not_found`; 429 (10 per 10 min per user).
- `POST /api/invites/[secret]/accept { confirmLeave: true }` (browser session) → 200 `{ tenantId, householdName }`; 400 `confirm_required`, 403 `email_mismatch`, 404 `not_found`, 409 `already_member` | `owns_household_with_members` | `already_in_household`; 429 (10 per 10 min per user). Emails the owner.
- Pages: `/settings/household`, `/invite/[secret]` (`Referrer-Policy: no-referrer`).
- Audit events written by the web app: `household.invite_created`, `household.invite_revoked`, `household.invite_resent` (emails hashed with `hashPii`).

## @neo/db (spec `_specs/owner-alerts.md`)

Migration `0008_alerts`: new `alerts` (`kind` `member_verdict|member_joined|member_left`, `severity` `low|medium|high|critical`, `title` ≤ 140, `body` ≤ 1000, `subject_user_id` / `acknowledged_by` → users `set null`, `verdict_id` → verdicts `set null`, `device_id` uuid without FK, `dedupe_key` unique per tenant, `email_status` `pending|sent|skipped|failed`, `emailed_at`) with the `tenant_isolation` RLS policy and in `tenantTables`; `memberships.alert_email_threshold` (`medium|high|critical|off`, default `high`); security-definer `purge_old_alerts() → integer` (acknowledged > 90 days, any > 180 days; `EXECUTE` granted to `app_user`).

```ts
createAlertWithOutbox(db, alertInput, plan: { cap, rows(alert), capRows(alert, dayStart) }) → { alert, enqueued, capped } | null;  // alert + outbox rows (destination encrypted via encryptContact(tenantId, idempotencyKey, address)) in one transaction
enqueueOutboxForAlert(db, tenantId, alertId, plan) → { enqueued, capped };  // pending alert with no rows only
claimOutboxRows(db, tenantId, { now?, limit? }) → OutboxRow[];  markOutboxSent / markOutboxFailed(db, tenantId, id, error, permanent) / settleAlertEmail(db, tenantId, alertId) / listPendingOutboxTenants(db)
createAlert(db, { tenantId, subjectUserId, kind, severity, title, body, dedupeKey, verdictId?, deviceId?, now? }) → AlertRow | null;  // null = deduplicated; text clipped
getAlert(db, tenantId, id) → AlertRow | undefined;
listAlerts(db, tenantId, { subjectUserId?, status?: "open" | "all", cursor?, limit? }) → { items: AlertListItem[], nextCursor? };  // + subjectName, acknowledgedByName; InvalidCursorError
countOpenAlerts(db, tenantId, { subjectUserId?, severities? }) → number;
acknowledgeAlert(db, tenantId, id, userId, now?) → AlertRow | undefined;  // idempotent
acknowledgeAllAlerts(db, tenantId, userId, now?) → number;
markAlertEmail(db, tenantId, id, status, at?);  countAlertEmailsSince(db, tenantId, since) → number;
listAlertOwners(db, tenantId) → { userId, email, name, threshold }[];
getAlertEmailThreshold(db, tenantId, userId);  setAlertEmailThreshold(db, tenantId, userId, threshold) → threshold | undefined;
purgeOldAlerts(db) → number;
```

### HTTP contract: alerts (`_specs/owner-alerts.md`)

Wire types: `apps/web/lib/alert-types.ts`. JSON errors `{ error, code }`; 503 `storage_unavailable` on store failure.

- `GET /api/alerts?status=open|all&cursor&limit` → `{ items: AlertItem[], nextCursor: string | null, openCount, urgentCount }`; owners see the household, members only alerts about themselves. 400 `bad_request` for a bad status, limit or cursor.
- `POST /api/alerts/[id]/acknowledge` (owner, browser session) → `{ alert }`; 404 `not_found`; 403 `forbidden` for members.
- `POST /api/alerts/acknowledge-all` (owner, browser session) → `{ acknowledged }`.
- `GET /api/settings/alerts` (owner) → `{ threshold }`; `POST { threshold }` (owner, browser session) → `{ threshold }`; 400 `bad_request`; 403 `forbidden` for members.
- Inngest event `neo/alert.created { alertId, tenantId }` → function `alert-created` (inline in `MOCK_MODE` without `INNGEST_EVENT_KEY`). Emails each owner at or above their threshold, at most 20 per household per UTC day, then one `alert-cap:<tenantId>:<date>` notice; Resend idempotency key `alert:<alertId>:<ownerUserId>`.
- `lib/server/verdicts.ts` `saveVerdict` raises `member_verdict` alerts for members' `malicious` (high) and `suspicious` (medium) verdicts, dedupe `verdict:<id>`. Household accept raises `member_joined` (high); leave and remove raise `member_left` (low); dedupe `<kind>:<userId>:<UTC hour>`. The direct "joined" email is removed.
- The daily retention job also calls `purgeOldAlerts`.
- Audit events: `alert.acknowledged`, `alert.acknowledged_all`, `settings.alert_threshold_changed`.

## @neo/db (spec `_specs/device-enrollment.md`)

Migration `0009_devices`:
- New `devices` (`kind` `browser_extension|desktop_agent`, `platform` `chrome|edge|firefox|windows|macos|linux`, `name` 1–64, `client_version` ≤ 32, `enrollment` `code|self`, `user_id` → users cascade, `enrolled_by` / `revoked_by` → users set null, `last_seen_at`, `offline_alerted_at`, `revoked_at`) and `device_enrollment_codes` (`user_id`, unique `code_hash`, `created_by`, `expires_at` 24 h, `redeemed_at`, `device_id` → devices set null, `revoked_at`), both with `tenant_isolation` RLS and in `tenantTables`.
- `desktop_tokens.scopes text[] not null default '{full}'` (checked against `TOKEN_SCOPES`) and `desktop_tokens.device_id` → devices cascade; check: `device_id is null` ⇔ `'full' = any(scopes)`.
- `desktop_auth_requests` gains nullable `device_kind`, `device_platform`, `device_name`, `device_client_version`.
- `alerts.kind` check adds `device_enrolled|device_offline|device_removed`; `alerts.device_id` becomes an FK to devices (set null).
- Security-definer functions (`EXECUTE` granted to `app_user` only): `lookup_device_enrollment_code(code_hash text) → (id, tenant_id)` for pending codes; `list_stale_devices(before timestamptz) → (id, tenant_id)` (active, never offline-alerted, `coalesce(last_seen_at, created_at) < before`); `purge_old_devices() → integer` (devices revoked > 90 days, codes redeemed/revoked/expired > 30 days).

```ts
TOKEN_SCOPES = ["full", "device", "signals:write", "url:check"] as const;  type TokenScope;
MONITORING_SCOPES = ["device", "signals:write", "url:check"] as const;
DEVICE_KINDS; DEVICE_PLATFORMS; type DeviceKind; type DevicePlatform;
MAX_DEVICES_PER_HOUSEHOLD = 20; MAX_PENDING_ENROLLMENT_CODES = 10;
ENROLLMENT_CODE_TTL_MS;   // 24 h
DEVICE_OFFLINE_AFTER_MS;  // 48 h
mintEnrollmentCode() → "XXXX-XXXX-XXXX";  normalizeEnrollmentCode(input) → string | null;  hashEnrollmentCode(code);
normalizeDeviceName(s) → string | null;
interface DeviceInput { kind: DeviceKind; platform: DevicePlatform; name: string; clientVersion: string }
interface DevicePublic { id, tenantId, userId, memberName: string | null, kind, platform, name, clientVersion, enrollment: "code" | "self",
                         enrolledBy: string | null, enrolledByName: string | null, createdAt, lastSeenAt: Date | null, offlineAlertedAt: Date | null, revokedAt: Date | null }
interface EnrollmentCodePublic { id, userId, memberName: string | null, createdBy: string | null, createdAt, expiresAt }

createEnrollmentCode(db, { tenantId, userId, createdBy, now? }) → { code, record: EnrollmentCodePublic } | { error: "not_member" | "code_limit" | "device_limit" };
listPendingEnrollmentCodes(db, tenantId, now?) → EnrollmentCodePublic[];              // newest first
revokeEnrollmentCode(db, tenantId, id, now?) → boolean;                                 // true also when already revoked; false for unknown
previewEnrollmentCode(db, { code, now? }) → { householdName, memberName, ownerName, expiresAt } | null;
redeemEnrollmentCode(db, { code, device: DeviceInput, now? })
  → { status: "enrolled", token, tokenId, device: DevicePublic, householdName, memberName, createdBy }
  | { status: "not_found" | "device_limit" | "invalid" };   // one tx: lock code FOR UPDATE, re-check pending + membership, insert device, mint MONITORING_SCOPES token, mark redeemed
enrollSelfDevice(db, { tenantId, userId, role, device: DeviceInput, now? })
  → { token, tokenId, device: DevicePublic } | { error: "device_limit" | "invalid" };
listDevices(db, tenantId, { userId? }) → DevicePublic[];      // active only, newest first
getDevice(db, tenantId, id) → DevicePublic | undefined;       // includes revoked
renameDevice(db, tenantId, id, name) → DevicePublic | "invalid" | undefined;
revokeDevice(db, { tenantId, deviceId, revokedBy: string | null, now? }) → { device: DevicePublic, alreadyRevoked: boolean } | undefined;  // revokes its tokens
recordHeartbeat(db, { tenantId, deviceId, clientVersion?, now? }) → DevicePublic | undefined;  // sets last_seen_at, clears offline_alerted_at; undefined if revoked
listStaleDevices(db, before) → { id, tenantId }[];
markDeviceOfflineAlerted(db, tenantId, deviceId, at) → DevicePublic | undefined;   // only if still active, stale and not alerted
purgeOldDevices(db) → number;
```

Changed:
- `ResolvedDesktopToken` gains `scopes: TokenScope[]` and `deviceId: string | null`. `resolveDesktopToken` returns null when the token's device is revoked.
- `listDesktopTokens` and the 10-per-user cap in `createDesktopToken` count only `full` tokens.
- `createDesktopAuthRequest(db, { clientName, device?: DeviceInput })`. `redeemDesktopAuthRequest` mints a monitoring token through `enrollSelfDevice` when the request carries a device, and adds `device: DevicePublic` to the approved result (`device_limit` is a new status). `DesktopAuthRequestPublic` gains `device: DeviceInput | null`.
- `removeHouseholdMember` / `leaveHousehold` also revoke the member's devices and pending enrollment codes in the household.

### Session scopes (apps/web)

- `NeoSession` gains `scopes: TokenScope[]` (browser sessions: `["full"]`) and `deviceId?`.
- `getSession(opts?: { scope?: TokenScope })`: a desktop token resolves only if it holds `opts.scope ?? "full"`. `requireSession` and existing routes are therefore closed to monitoring tokens.
- `requireApiSession(opts?)` / `requireBrowserApiSession()`: 403 `insufficient_scope` (not 401) for a valid token without the scope.
- Browser (Auth.js and DEV_AUTH_BYPASS) sessions always resolve with `scopes: ["full"]` and no `deviceId`, whatever scope is asked for; a route that needs a device must also check `session.deviceId`.
- Member-only devices (M2 slice 1a): `NeoSession` stays the person shape (`userId: string`, `role`, `deviceId?: undefined`; also exported as `PersonSession`), and a monitoring token resolves to the new `DeviceSession = { tenantId, memberId, deviceId, userId: string | null, role: MembershipRole | null, email, name, desktopTokenId, scopes }` (`userId`/`role` null for a member without an account; `memberId` read from the device row, never the token). `getSession()`/`requireApiSession()` are overloaded: the default `full` scope returns `NeoSession`, any other scope `NeoSession | DeviceSession` (`AnySession`; narrow with `isDeviceSession` or `deviceId !== undefined`). Device routes use `requireDeviceSession(scope)` → `DeviceSession` (same 401/403 as `requireApiSession`, plus 403 `insufficient_scope` for a browser session). Device routes never read `role`; `deviceAuditActor(session)` gives the audit actor (the account's user id when there is one, else `userId: null` plus `actor: "device:<deviceId>"` in the metadata, because `audit_events.user_id` is a users FK).
- A `Bearer neo_dt_…` header is resolved before DEV_AUTH_BYPASS and decides alone (session, 403 `insufficient_scope`, or 401), so device clients can be developed against MOCK_MODE with the bypass on.
- Server helpers: `lib/server/devices.ts` (db-or-memory dispatch for every @neo/db devices function, `toDeviceItem(d, now?)`, `toEnrollmentCodeItem`, `deviceStatus`); in-memory twin `lib/server/memory-devices.ts`.

### HTTP contract: devices (`_specs/device-enrollment.md`)

Wire types in `apps/web/lib/household-types.ts`:
- `DeviceItem = { id, userId /* string | null: null for a member without an account */, memberName, kind, platform, name, clientVersion, enrollment, enrolledByName, createdAt, lastSeenAt, status: "active" | "offline" | "never_seen" }`
- `EnrollmentCodeItem = { id, userId /* string | null */, memberName, createdAt, expiresAt }`

JSON errors `{ error, code }`.

- **Household view:** `GET /api/household` adds `devices: DeviceItem[]` (owner: all; member: their own) and `enrollmentCodes: EnrollmentCodeItem[]` (owner only).
- **Enrollment codes (owner, browser session):**
  - `POST /api/household/members/[userId]/enrollment-codes` → 201 `{ id, code, expiresAt, memberName }`; 404 `not_found`; 409 `code_limit` | `device_limit`.
  - `POST /api/household/protected-members/[id]/enrollment-codes` (M2) → same response; the id is a `members` row id, so the code can be for a member without an account. Owner re-read from the database (`requireHouseholdAdmin`): 403 `forbidden`; 404 `not_found` for an unknown, malformed or other household's id.
  - `DELETE /api/household/enrollment-codes/[id]` → 204; idempotent for a code in the household (also used or already cancelled); 404 `not_found` for unknown ids.
- **Enrollment (no auth; shared 10 per hour per IP):**
  - `POST /api/devices/enroll/preview { code }` → `{ householdName, memberName, ownerName, expiresAt }`; 404 `not_found`; 400 `invalid` without a `code` string.
  - `POST /api/devices/enroll { code, kind, platform, name, clientVersion }` → 201 `{ token, tokenId, device, householdName, memberName }` (`Cache-Control: no-store`); 404 `not_found`; 409 `device_limit`; 400 `invalid` (bad device fields or no `code`).
  - 429 `rate_limited` with `Retry-After`.
- **Device self-service (scope `device`):**
  - Both require a monitoring token's own `deviceId`: a browser session (which resolves for any scope) or a full token gets 403 `insufficient_scope`; a revoked device's token gets 401.
  - `POST /api/devices/heartbeat { clientVersion? }` → `{ device, householdName, memberName, heartbeatSeconds: 3600 }`; 12 per hour per device (429); 400 `invalid` for a non-string or over-32-character `clientVersion`.
  - `DELETE /api/devices/self` → 204; the device's `revoked_by` is null (audit `by: "device"`).
- **Device management (browser session):**
  - `PATCH /api/household/devices/[id] { name }` (owner) → `{ device }`.
  - `DELETE /api/household/devices/[id]` (owner, or the protected member) → 204; 403 `forbidden`; 404 `not_found` (unknown or already removed).
  - Both are browser-only: a full desktop token gets 403 `browser_session_required`. Members get 403 `forbidden` from PATCH and from the code routes.
- **Device sign-in:** `POST /api/desktop/device` accepts `device?: { kind, platform, name, clientVersion }` (malformed → 400 `bad_request`). The token response adds `scopes` and `device: DeviceItem | null` (null for a full token); 409 `device_limit` when the household has 20 active devices. `/desktop/authorize` names what is granted.
- **Alerts:**
  - `device_enrolled` (low, self-enrollment by a non-owner through the device flow, raised in `redeemDeviceAuth`; dedupe `device_enrolled:<deviceId>`).
  - `device_removed` (high, removal by the member or the device, dedupe `device_removed:<deviceId>`).
  - `device_offline` (medium, dedupe `device_offline:<deviceId>:<epoch ms of lastSeenAt ?? createdAt>`).
  - Helpers in `lib/server/alerts`: `alertDeviceEnrolled(device)`, `alertDeviceRemoved(device, by: "member" | "device")`, `alertDeviceOffline(device)`; each returns whether an alert was raised and skips devices whose member is an owner or gone. Emails link to `/settings/household` (no `verdictId`).
  - Devices protecting an owner never alert; owners' own actions never alert.
- **Offline job:** Inngest cron `devices-offline` (`0 * * * *`) runs `runOfflineDeviceSweep(deps?, now?) → { stale, marked, alerted, errors }` (`lib/server/device-enrollment.ts`). The daily retention job (`artifacts-expire`) gains `ExpireDeps.purgeOldDevices` and a `purge-devices` step; its result adds `devicesDeleted`.
- **Server module:** `lib/server/device-enrollment.ts` holds the session-level operations (`Outcome<T>` like `lib/server/household.ts`): `householdDevices`, `createCode`, `revokeCode`, `previewEnrollment`, `enrollWithCode`, `renameHouseholdDevice`, `removeHouseholdDevice`, `heartbeat`, `unenrollSelf`; limits `DEVICE_ENROLL_LIMIT`, `HEARTBEAT_LIMIT`.
- **Member email:** enrollment by code emails the member (`renderDeviceEnrolledEmail`, subject `A device is now protected by Neo`, link `<request origin>/settings/household`), with idempotency key `device-enrolled:<deviceId>`; not sent when the member created the code (an owner enrolling their own device).
- **Audit events:** `device.enrollment_code_created`, `device.enrollment_code_revoked`, `device.enrolled`, `device.renamed`, `device.revoked` (`by: "owner" | "member" | "device"`).

## @neo/verdict and @neo/tools (spec `_specs/signals.md`)

`@neo/verdict`:
- `SUBJECT_TYPES` adds `software`, `remote_session` and `permission`.
- New `packages/verdict/src/signals.ts`, exported from the index:

```ts
SIGNAL_TYPES = ["page", "software", "remote_session", "permission"] as const;   // M2 adds "usage" and "tamper" (see "Child policy" in the v2 section)
SIGNAL_DETECTORS = ["tech_support_scam", "lookalike_login", "dangerous_site", "remote_tool_download", "warning_bypassed",
                    "remote_access_tool", "unwanted_software", "remote_access_session", "tcc_grant"] as const;
TECH_SUPPORT_INDICATORS; LOOKALIKE_INDICATORS;           // the indicator code lists from the spec table
MAX_SIGNAL_BATCH = 50;
SignalEventSchema: z.ZodType<SignalEvent>;                // discriminated union on `detector`, every variant .strict()
type SignalEvent;                                         // { id: uuid, type, detector, observedAt: ISO string, ...payload }
parseSignalEvent(raw: unknown) → { ok: true, event: SignalEvent } | { ok: false, id: string | null, reason: "invalid" };
```

The schema checks shape only: `domain` is lowercase host characters with no `/ ? # : @` and 1–253 characters, and `sha256` is 64 lowercase hex characters. The server checks that `domain` is registrable, that `observedAt` is fresh, and that `toolId` exists.

`@neo/tools`:
- Data files in `src/data/`: `remote-access-tools.json`, `pup-publishers.json`, `scam-page-phrases.json` (`{ phrase, kind: "support_phone_text" | "fake_scan", lang: "en" }`) and `skip-domains.json`.

```ts
interface RemoteAccessTool { id; name; vendorDomains: string[]; installerPatterns: string[];
  windows: { publishers: string[]; displayNamePatterns: string[]; serviceNames: string[]; processNames: string[] };
  macos: { bundleIds: string[]; teamIds: string[] }; sessionHints: string[] }
REMOTE_ACCESS_TOOLS: readonly RemoteAccessTool[];  findRemoteAccessTool(id) → RemoteAccessTool | undefined;
PUP_PUBLISHERS: readonly { publisher?: string; sha256?: string; reason: string }[];
SCAM_PAGE_PHRASES; SKIP_DOMAINS: readonly string[];   // suppresses only the lookalike-login heuristic
USER_CONTENT_HOSTS: readonly string[];               // never in SKIP_DOMAINS (github.io, amazonaws.com, sharepoint.com, google.com, …)
detectionLists() → { version: string; remoteAccessTools; pupPublishers; scamPagePhrases; skipDomains };  // version = sha256 of canonical JSON, first 16 hex chars
```

## @neo/db (spec `_specs/signals.md`)

Migration `0010_signals`:
- **New tables:**
  - `device_signals`: `id`, `tenant_id`, `device_id` (cascade), `user_id` (cascade), `client_event_id` uuid, `type`, `detector`, `subject` (≤ 253), `payload` jsonb, `severity` null | `low|medium|high|critical`, `outcome` `pending|alerted|recorded|dismissed`, `escalated` boolean default false, `verdict_id` (set null), `alert_id` (set null), `observed_at`, `received_at`.
    - Unique `(device_id, client_event_id)`.
    - Index `(tenant_id, user_id, observed_at desc)`.
  - `device_expected_tools`: `tenant_id`, `device_id` (cascade), `tool_id`, `peer_ids text[]`, `created_by`, `created_at`, with primary key `(device_id, tool_id)`.
  - Both get `tenant_isolation` RLS and are in `tenantTables`.
  - `reputation_cache` (`key` text primary key, `value` jsonb, `expires_at`): no tenant and no RLS, with CRUD granted to `app_user`.
- **Changed checks:**
  - `verdicts.subject_type` adds `software|remote_session|permission`.
  - `verdicts.source` adds `device`.
  - `alerts.kind` adds `scam_page|dangerous_site|remote_access|unwanted_software|permission_grant|scam_in_progress`.
- **Security-definer functions** (granted to `app_user`): `purge_old_device_signals() → integer` (older than 30 days by `received_at`) and `purge_expired_reputation_cache() → integer`.

```ts
SIGNAL_OUTCOMES; type DeviceSignalRow;
insertDeviceSignal(db, { tenantId, deviceId, userId, clientEventId, type, detector, subject, payload, observedAt, escalated?, now? })
  → { row: DeviceSignalRow; duplicate: boolean };          // on conflict (device_id, client_event_id) returns the existing row, duplicate true
getDeviceSignal(db, tenantId, id) → DeviceSignalRow | undefined;
updateDeviceSignal(db, tenantId, id, { severity?, outcome?, verdictId?, alertId? }) → DeviceSignalRow | undefined;
listRecentUserSignals(db, tenantId, userId, { since, outcomes? }) → DeviceSignalRow[];   // oldest first, for correlation
countDeviceSignalsSince(db, tenantId, deviceId, since, { escalatedOnly? }) → number;
purgeOldDeviceSignals(db) → number;
listExpectedTools(db, tenantId, { deviceId? }) → { deviceId, toolId, peerIds, createdBy, createdAt }[];
setExpectedTools(db, { tenantId, deviceId, tools: { toolId, peerIds }[], createdBy }) → same shape[] | undefined;  // replaces the set; undefined when the device is unknown or revoked
class PostgresReputationCache implements ReputationCache { constructor(db: Db) }   // structural: get(key), set(key, value, ttlSeconds)
purgeExpiredReputationCache(db) → number;
```

### HTTP contract: signals (`_specs/signals.md`)

Wire types in `apps/web/lib/signal-types.ts`:
- `SignalResult = { id: string | null, status: "accepted" | "duplicate" | "rejected", reason?, severity?, verdictId?, pending? }`
- `SignalIngestResponse = { results: SignalResult[] }`
- `DetectionListsResponse`

JSON errors `{ error, code }`.

- **Ingest:** `POST /api/signals { events }` (scope `signals:write` + `deviceId`, else 403 `insufficient_scope`).
  - 200 with per-event results.
  - 400 `bad_request` when the body is not `{ events: array of 1..50 }`.
  - 429 at 60 requests per hour per device.
  - Rejection reasons: `invalid | stale | unknown_tool | rate_limited | relates_to_unknown`.
  - 500 accepted events per device per UTC day; escalations at most 50 per device per day.
- **Lists:** `GET /api/signals/lists` (scope `device` + `deviceId`) → `DetectionListsResponse`.
  - `ETag: "<version>"`, 304 on a matching `If-None-Match`.
  - `Cache-Control: private, max-age=3600`.
  - M2 slice 4 adds `categoryLists` (additive; older clients ignore it) and widens `version` (so the ETag and the heartbeat `listsVersion` change when the category data does): see "Category lists (M2 slice 4)" in the v2 section.
- **Heartbeat:** the `POST /api/devices/heartbeat` response adds `listsVersion`.
- **Expected tools:** `PUT /api/household/devices/[id]/expected-tools { tools: { toolId, peerIds }[] }` (owner, browser session) → `{ tools: { toolId, name, peerIds }[] }`.
  - At most 10 tools, 10 peer IDs each, each ID at most 64 characters.
  - 400 `unknown_tool` | `invalid`, 404 `not_found`, 403 `forbidden`.
  - Audit `device.expected_tools_changed`.
  - `DeviceItem` gains `expectedTools`.
- **Escalation:** Inngest event `neo/signal.escalate { signalId, tenantId }` → function `signal-escalate` (concurrency 1 per tenant, 3 retries; inline in MOCK_MODE without `INNGEST_EVENT_KEY`).
- **Verdicts:** saved with `source: "device"`. `saveVerdict` does not call `alertForVerdict` for `device`.
- **Alerts:**
  - Dedupe key `<kind>:<deviceId>:<detector>:<subject>:<UTC hour>` (amended by the desktop agent, see the last section), except `scam_in_progress:<userId>:<30-min bucket>` and `bypass:<relatesTo>`.
  - Owners' own devices alert and email like members'.
- **Shared reputation cache:** with a database, `PostgresReputationCache` backs the shared URL cache (chat and signals); in-memory otherwise.
- **Retention:** the daily retention job calls `purgeOldDeviceSignals` and `purgeExpiredReputationCache`.
- **Audit:** `device.expected_tools_changed`, `signals.flood`.

## @neo/verdict and @neo/tools (spec `_specs/browser-extension.md`)

`@neo/verdict` (`src/signals.ts`):

```ts
TECH_SUPPORT_TEXT_INDICATORS = ["support_phone_text", "fake_scan"] as const;
isTechSupportScamHit(indicators: readonly TechSupportIndicator[]) → boolean;  // ≥ 1 text indicator and ≥ 2 distinct indicators in total
```

The server rule for `tech_support_scam` uses it (amends `_specs/signals.md`: fullscreen + pointer lock alone is `recorded`).

`@neo/tools`:
- New subpath export `@neo/tools/browser` (`src/browser.ts`): no Node built-ins anywhere in its import graph (no `node:*`, no `undici`, no `@neo/core`), safe for a Vite browser build.

```ts
registrableDomain(host: string) → { registrable: string; subdomain: string; isIp: boolean } | null;  // tldts, lowercase, punycode input
toUnicodeHost(host: string) → string;                                    // RFC 3492 decode of xn-- labels (in-repo, no dependency)
detectLookalike(host: string, brands?: Brand[]) → Lookalike | null;      // same results as the Node entry
skeleton(label: string) → string;
extractPhoneNumbers(text, opts?) → string[];  parsePhone(raw, userCountry?) → ParsedPhone | undefined;
normalizeForMatch(s: string) → string;
brandId(name: string) → string;                                          // stable slug, matches /^[a-z0-9_-]{1,64}$/
type Brand; type Lookalike; type ListBrand = { id: string; name: string; domains: string[]; keywords: string[] };
type DetectionListsPayload;                                              // the JSON shape of detectionLists(), for clients
```

- The Node entry keeps exporting `detectLookalike`, `skeleton`, `normalizeUrl` with unchanged behaviour; the Node-only code (`node:url` `domainToUnicode`, `node:net` `isIP`) is replaced by the shared browser-safe helpers where results are identical.
- `detectionLists()` adds `brands: ListBrand[]` (from `BRANDS`, `id = brandId(name)`, ids unique); `version` covers it.

## apps/web (spec `_specs/browser-extension.md`)

- **Signal status:** `GET /api/signals/status?ids=<uuid>,<uuid>` (scope `signals:write` + `deviceId`, else 403 `insufficient_scope`) → `{ results: { id, outcome: "pending" | "alerted" | "recorded" | "dismissed", severity?, verdictId?, alerted: boolean }[] }`.
  - 1–50 ids, else 400 `bad_request`. Only this device's events; unknown ids omitted.
  - 120 per hour per device (429 with `Retry-After`).
- **On-demand check:** `POST /api/devices/check-url { url }` (scope `url:check` + `deviceId`) → `{ rating: "dangerous" | "suspicious" | "no_known_problems" | "unknown", domain, reasons: string[], checkedAt }`.
  - `url` ≤ 2048 characters, `http`/`https` only, else 400 `invalid`.
  - Runs `analyzeUrl` with the shared reputation cache; `classifyUrlAnalysis(analysis) → { rating, reasons }` in `lib/server/signals/classify.ts` is shared with the lookalike escalation.
  - Not saved, no alert, not counted against monthly checks. 30 per hour and 200 per UTC day per device (429 with `Retry-After`). Logs the registrable domain only (`@neo/core`'s `SAFE_METADATA_FIELDS` gained `domain` for this).
- **Lists:** `DetectionListsResponse` adds `brands`.
- **Heartbeat:** the response adds `uninstallUrl` (`<origin>/uninstalled?d=<deviceId>&s=<sig>`; `sig` = base64url of HMAC-SHA256(key, deviceId), first 22 characters; key = HMAC-SHA256(`AUTH_SECRET`, `"neo-uninstall-v1"`), with a fixed dev key when `AUTH_SECRET` is unset and this is not a deployment (`isDeployedEnvironment`: `NODE_ENV=production` or `VERCEL_ENV` production/preview, the same test as `DEV_AUTH_BYPASS`). `AUTH_SECRET` unset on a deployment: no `uninstallUrl` is minted and `lib/server/uninstall.ts` verifies no signature as valid.
- **Uninstall:** `POST /api/devices/uninstalled { d, s }` (no auth) → 204 always for a well-formed body (400 `bad_request` otherwise); a valid signature for an active device revokes it and its tokens and raises `device_removed` (`by: "device"`, template "… was uninstalled"); idempotent; 10 per hour per IP (429).
  - Page `app/uninstalled/page.tsx` (public) posts once on load and shows the result copy. `vercel.json` adds `Referrer-Policy: no-referrer` for `/uninstalled`.
- **Store links:** `NEXT_PUBLIC_CHROME_EXTENSION_URL`, `NEXT_PUBLIC_FIREFOX_EXTENSION_URL` (optional). Settings → Household → Add a device links to them; unset shows "coming soon" for that browser.

## apps/extension (spec `_specs/browser-extension.md`)

WXT MV3 package `@neo/extension`; scripts `dev`, `build` (chrome-mv3 and firefox-mv3), `zip`, `typecheck`, `lint`, `test`. Build-time `WXT_NEO_BASE_URL` (default `https://www.neoshield.dev`). Consumes only the HTTP contracts above and `@neo/verdict`, `@neo/tools/browser`.

Child mode (M2 slice 4, spec `_specs/v2-m2-child.md` sections 5 and 6, "Slice 4: what was built"):
- Manifest: adds the permission `declarativeNetRequestWithHostAccess` and `web_accessible_resources: [{ resources: ["blocked.html"], matches: ["<all_urls>"] }]`. No `tabs`, `webNavigation`, `history`, `unlimitedStorage`.
- Build-time `NEO_POLICY_PUBKEYS` (a JSON array of P-256 JWKs, each with `kid`; unset: the committed production key in `lib/policy/default-keys.json`; set but invalid: the build fails). Passed to the code as the Vite define `__NEO_POLICY_PUBKEYS__`.
- Calls: `GET /api/devices/policy` (verify with `verifyPolicyEnvelope`, keep the last valid bundle), heartbeat `policyVersion` (applied) both ways, `POST /api/devices/requests` and `GET /api/devices/requests/:id` (`unblock_site` only), `GET /api/signals/lists` `categoryLists`, and the category files at `categoryLists.baseUrl`.
- Sends `web_blocked`, `payment_page` (every mode) and `tamper_detected { reason: "bad_policy_signature" }`. Never sends a URL.
- Messages to the background (internal): `check-host`, `block-page-shown`, `request-unblock`, `request-status`, `payment-page-hit`.

## Desktop agent (spec `_specs/desktop-agent.md`)

`@neo/verdict`:
- `remote_access_tool` and `unwanted_software` events accept optional `discovery: "baseline" | "new"` (absent = `"new"`); still `.strict()`. `DISCOVERY_VALUES = ["baseline", "new"] as const`.

`@neo/tools`:
- `RemoteAccessTool.windows` gains `sessionEvidence: SessionEvidence[]`:

```ts
type SessionEvidence =
  | { kind: "log"; path: string; pattern: string; verified: boolean; checked?: string }       // path may use %ProgramData% %ProgramFiles% %ProgramFiles(x86)% %AppData%; pattern may capture (?<peer>…)
  | { kind: "eventlog"; channel: string; eventIds: number[]; verified: boolean; checked?: string }
  | { kind: "process"; name: string; verified: boolean; checked?: string };                    // exists only during a session
// checked: "<vendor version> <YYYY-MM-DD>" recorded by the VM verification task
```

- Every regex string in the lists (`installerPatterns`, `displayNamePatterns`, `sessionEvidence[].pattern`) uses the JS/Rust shared subset: no lookaround, no backreferences, named groups only as `(?<name>…)`, no inline flags. Enforced by `packages/tools/test/lists.test.ts`.
- `detectionLists()` includes `sessionEvidence`; `version` covers it.

`apps/web`:
- **Baseline rule:** `remote_access_tool` with `discovery: "baseline"` → `suspicious` verdict, `medium` (or `low` when expected); template title `<device>: <tool> is installed`. `unwanted_software` baseline follows the normal rule (agents never send baseline `unsigned_unknown`; the server rejects it as `invalid`).
- **Correlation:** baseline events never count toward `scam_in_progress`.
- **Device-signal alert dedupe:** `<kind>:<deviceId>:<detector>:<subject>:<UTC hour>` (was without `<detector>`), so an install alert and a session alert for the same tool are separate. `scam_in_progress` and `bypass:` keys unchanged.
- **Heartbeat:** `device: DeviceItem` carries the device's real `expectedTools` (was always `[]`).
- **Add a device:** Windows link from `NEXT_PUBLIC_WINDOWS_AGENT_URL` (optional); unset → "coming soon".

`apps/desktop` (Tauri v2 + Rust; not a turbo task for Rust):
- `@neo/desktop` (pnpm, React UI only): `typecheck`, `lint`, `test`, `build`.
- Cargo workspace `apps/desktop/Cargo.toml`: `src-tauri` (tray app `neo-desktop`), `crates/agent-core` (pure, cross-platform, tested on Linux), `crates/agent-service` (`neo-agent.exe`, Windows service `NeoAgent`, display name "Neo Protection").
- Named pipe `\\.\pipe\neo-agent`, newline-delimited JSON, ≤ 16 KB per request:
  - Requests: `{ "op": "status" | "enroll_preview" | "enroll" | "self_enroll_start" | "self_enroll_poll" | "check_url" | "unenroll" | "subscribe", ...args }` → `{ "ok": true, ...result }` or `{ "ok": false, "code", "error" }`.
  - Pushes after `subscribe`: `{ "push": "warning", eventId, kind: "tool" | "session" | "unwanted", toolName, peerId?, severity, ownerName, ownerTold }`, `{ "push": "status_changed" }`.
- Data dir `C:\ProgramData\Neo\`: `device.bin` (DPAPI machine scope), `seen.json`, `queue.json`, `cursors.json`, `lists.json`, `logs\`.
- Updates: Tauri-format `latest.json` (`version`, `notes`, `pub_date`, `platforms["windows-x86_64"].{url, signature}`), minisign public key compiled in, MSI Authenticode signer checked, `msiexec /i <msi> /qn`. Build-time `NEO_DESKTOP_UPDATE_URL`, `NEO_BASE_URL`.
- Pipe protocol as built (detail in `docs/desktop-agent.md` "Pipe protocol details"):
  - `status` → `{ ok, state: "not_enrolled" | "enrolled" | "disconnected", version, serverUrl, computerName, deviceName, memberName, householdName, ownerName, lastCheckIn, lastWarningAt, updateAvailable }`.
  - `enroll_preview`, `enroll`, `self_enroll_start` accept optional `serverUrl` (`https://`, or loopback `http://`); refused once enrolled.
  - `self_enroll_start` → `{ userCode, verificationUri, verificationUriComplete, expiresIn, interval }` (device code stays in the service); `self_enroll_poll` → `{ status: "pending" | "approved" | "denied" | "expired" }`.
  - `subscribe` makes the connection push-only; clients use a second connection for requests. Blank lines are keep-alives.
  - A warning may be pushed twice with the same `eventId`: first `ownerTold: false`, then `ownerTold: true` once the server accepted it at `medium`+.
  - Error codes: `request_too_large`, `invalid_json`, `invalid_request`, `unknown_op`, `not_enrolled`, `already_enrolled`, `invalid_code`, `invalid_server_url`, `server_unreachable`, `rate_limited`, `device_limit`, `disconnected`, `no_sign_in`, `storage_failed`, `server_error` (tray adds `agent_unavailable`). At most 32 connections; an oversize request is answered once and the connection closed.
- The MSI installs `neo-agent.exe` through its own WiX component (not Tauri `externalBin`); build-time `TAURI_NEO_AGENT_EXE` points at it. Build-time `NEO_DESKTOP_UPDATE_PUBKEY` (unset = updates off) and CI-only `NEO_ALLOW_UNSIGNED_UPDATE`.

## Desktop agent, macOS (spec `_specs/desktop-agent-macos.md`)

`@neo/tools`:
- `RemoteAccessTool.macos` gains `sessionEvidence: SessionEvidence[]` (same union as Windows) and the union gains:

```ts
| { kind: "unifiedlog"; predicate: string; pattern: string; verified: boolean; checked?: string }
// predicate is exactly `process == "<name>"` or `subsystem == "<name>"` (name: [A-Za-z0-9._-]{1,64}); pattern follows the shared regex subset
```

- macOS log paths may use `%Home%` (expanded once per local user); Windows tokens stay as they are.
- New tool id `apple_screen_sharing` ("Apple Screen Sharing / Remote Management"): no `vendorDomains`, no `installerPatterns`, no Windows signals; macOS session evidence only. Agents never send `remote_access_tool` for it.

`agent-core` (Rust):
- `snapshot::TccRow { db: String /* "system" | "user:<uid>" */, service: String, client: String, client_type: i64, auth_value: i64 }`; `snapshot::TccSnapshot { dbs_read: Vec<String>, rows: Vec<TccRow> }`; `Snapshot.tcc: Option<TccSnapshot>` (None = nothing readable / no Full Disk Access / schema not understood: state untouched). `dbs_read` lists the databases that were actually read this pass (a database that could not be read must not be listed).
- `detect::detect_tcc(seen, Option<&TccSnapshot>, bundles, now)` compares and updates state only for the databases in `dbs_read`: a database not read this pass keeps its previous state (a user logging out is not a revoke, their return not a grant), and a database read for the first time is baselined silently even after other databases were baselined. Rows whose `db` is not in `dbs_read` are ignored. `SeenState` stores the set of baselined databases (`tcc_dbs`; `tcc_baselined()` = any; `swap_tcc(dbs_read, current)`).
- `detect` emits `tcc_grant` (`type: "permission"`, `app`, `bundleId?`, `service: "screen_recording" | "accessibility" | "full_disk_access"`) only for transitions to `auth_value == 2` after that database's first read since enrollment; dedupe on `(client, service)`; Neo's own bundle ids ignored. Mapping: `kTCCServiceScreenCapture` → `screen_recording`, `kTCCServiceAccessibility` → `accessibility`, `kTCCServiceSystemPolicyAllFiles` → `full_disk_access`. `TccService::as_str()` is the wire name.
- `warn::WarningKind` gains `Permission` (push `kind: "permission"`): a `tcc_grant` to a listed remote-access tool (matched on `bundleId`, not expected on the device) is `Permission`, no longer `Session`; any other grant never warns locally. The push carries `service`.
- macOS matching uses `macos.bundleIds` and `macos.teamIds` (Team ID plays the role of the Authenticode publisher).

Agent service (macOS):
- Daemon bundle `/Library/Application Support/Neo/Neo Protection.app` (`CFBundleIdentifier` `dev.neoshield.agent`), executable `Contents/MacOS/neo-agent`, LaunchDaemon `dev.neoshield.agent` (root, `KeepAlive`). Tray `/Applications/Neo.app`, LaunchAgent `dev.neoshield.tray`. Pkg identifier `dev.neoshield.pkg`.
- Data dir `/Library/Application Support/Neo/data` (root `0700`, created before contents): `device.json` (`0600`) plus the same state files as Windows.
- IPC: Unix socket `/var/run/neo-agent.sock` (`0666`, root-owned; the daemon calls `getpeereid` on every connection and drops a peer it cannot verify, any local user is served), the same protocol as the Windows pipe; `status` adds `platform: "windows" | "macos" | "linux"` (`linux` = development build) and `fullDiskAccess: boolean | null` (null off a Mac); new op `probe_permissions` → `{ ok, fullDiskAccess: boolean | null, restarting: boolean }`.
- Warning push `kind` is now `"tool" | "session" | "unwanted" | "permission"`; `permission` adds `service: "screen_recording" | "accessibility" | "full_disk_access"` (shown in the critical window with the spec copy, adapted by service). The tray's allowed web-view ops gain `probe_permissions`; the tray's own commands `open_full_disk_access`, `reveal_daemon` and `uninstall_mac` take no arguments (every address and path is hardcoded in Rust).
- Updates: `latest.json` platform `darwin-universal`; minisign, then `pkgutil --check-signature` must show `Developer ID Installer: … (<TEAMID>)` equal to the daemon's own Team ID and a notarization line; `installer -pkg <pkg> -target /`.
- Uninstall: `uninstall.sh` in the daemon bundle and the tray's Uninstall item; `/Applications/Neo.app` missing for 10 minutes (build-time override `NEO_TRASH_GRACE_SECS`) → unenroll and remove.

`apps/web`: Add a device links `NEXT_PUBLIC_MAC_AGENT_URL` (optional; unset → "coming soon"); privacy page macOS paragraph.

### As built (macOS), differences and additions

- **`probe_permissions` restarts the daemon.** A Full Disk Access grant is only visible to a process started after it, so the first failed probe makes the daemon exit once (`restarting: true`; launchd `KeepAlive` relaunches it ~1 s after the reply is written). `agent.json` `fda_relaunch_at` (unix seconds) limits this to once per minute and is cleared by a successful probe; only this op ever restarts it (the 5-minute re-probe does not).
- **Full Disk Access cache:** `status.fullDiskAccess` is the daemon's cached probe (probed on first `status`, every 5 minutes while missing, and on `probe_permissions`); a change pushes `status_changed`.
- **Scheduling:** the unified-log query and the TCC read ride the existing 30-second `EventLog` task; app bundles and launchd items ride the 60-second `Slow` task; launchd items are reported as `ServiceInfo { name: label, binary_path: program }` so `service_names` matching is shared.
- **TCC database reading** uses `immutable=1` only when no non-empty `-wal` exists; otherwise the database and its `-wal` are copied to `<data>/tmp/`, read and deleted (an immutable read ignores the WAL and would miss a fresh grant).
- **Trash rule:** the check interval is a quarter of the grace period clamped to 5-60 s (60 s for the default 600 s). The daemon unenrolls (`DELETE /api/devices/self`) itself before running `uninstall.sh`, so the script's `--unenroll` sends nothing and the owner is told once; removal proceeds even if the server is unreachable or the device was not enrolled. `NEO_TRASH_GRACE_SECS` is compile-time and CI-only (the macOS release refuses it).
- **Device platform:** a macOS build enrolls with `platform: "macos"` (the server already accepts it) and signs in as "Neo for Mac".
- **Data directory modes:** `DataDir` creates directories `0700` and files `0600` on every unix; the daemon sets `umask 077`; `device.json` is re-tightened to `0600` whenever it is loaded.
- **Installer trait:** `Installer::extension()` (default `msi`, `pkg` on macOS) names the staged file; `update::UPDATE_PLATFORM` is `darwin-universal` on macOS.
- **`SystemProbe`** gains default methods `platform`, `app_bundles`, `bundle_exe_facts`, `unified_log`, `full_disk_access`, `tcc`; `Notifier` and the rest are unchanged. `FileSecretStore::named(dir, protector, file)` (macOS: `device.json`, `PlainProtector`).
- **`latest.json`:** `ci/make-latest-json.mjs --platform <key> --merge-into <existing>`; `ci/publish-manifest.sh` merges and re-verifies on the rolling release (both release workflows use it).
- **Packaging:** `apps/desktop/macos/` (`Neo Protection.app` skeleton, `launchd/`, `scripts/preinstall|postinstall`, `distribution.xml`, `build-pkg.sh`); the daemon plist sets `AbandonProcessGroup` and `AssociatedBundleIdentifiers`. `build-pkg.sh` marks the components non-relocatable (`pkgbuild --component-plist`), ad-hoc signs both bundles when no identity is given, and refuses to build when the daemon and the tray app are signed by different teams.
- **Signer names and trust:** `AppBundle.signer` (for `pupPublishers`) is the leaf certificate's subject summary without the `Developer ID Application:` prefix and the Team ID; `AppBundle.team_id`, `signing_id` and `ExeFacts.signed_trusted` are set only for a signature that validates against the Developer ID requirement (Apple's own: `anchor apple`, identifier only), never from an ad-hoc or broken signature.

---

## @neo/db (spec `_specs/weekly-digest.md`)

```ts
export type DigestDeliveryState = "sending" | "sent" | "empty" | "failed";
export type DigestDelivery = { tenantId: string; userId: string; isoWeek: string; state: DigestDeliveryState; periodStart: Date; periodEnd: Date; claimedAt?: Date; runId?: string; providerMessageId?: string; createdAt: Date; updatedAt: Date };
// digest_deliveries: UNIQUE (user_id, iso_week); encrypted payload bytea; tenant_isolation RLS; registered in tenantTables; app_user grant.
// The delivery DTO deliberately omits payload. save/get require the current sending run; terminal states clear it.
// A security-definer sweep clears non-sending payloads and sending payloads older than 24 hours.
// memberships.weekly_digest_enabled boolean NOT NULL; role defaults are set on creation/change.
// list_digest_recipients(cursor_tenant_id uuid, cursor_user_id text, limit integer) returns tenant_id/user_id only,
// cursor-paginated with LIMIT 1000; SECURITY DEFINER; EXECUTE revoked from PUBLIC and granted to app_user.
export const weeklyDigest: {
  listDigestRecipientPairs(db: Db, opts: { cursor?: string; limit: number /* 1..1000 */ }): Promise<{ items: Array<{ tenantId: string; userId: string }>; nextCursor?: string }>;
  getPreference(db: Db, tenantId: string, userId: string): Promise<boolean | undefined>;
  setPreference(db: Db, tenantId: string, userId: string, enabled: boolean): Promise<boolean>;
  getDelivery(db: Db, tenantId: string, userId: string, isoWeek: string): Promise<DigestDelivery | undefined>;
  claimDelivery(db: Db, input: { tenantId: string; userId: string; isoWeek: string; periodStart: Date; periodEnd: Date; runId: string; now: Date }): Promise<{ result: "claimed" | "owned_live" | "terminal" | "household_move_collision"; delivery?: DigestDelivery }>;
  savePayload(db: Db, input: { tenantId: string; userId: string; isoWeek: string; runId: string; payload: Uint8Array; now: Date }): Promise<boolean>;
  getPayload(db: Db, input: { tenantId: string; userId: string; isoWeek: string; runId: string }): Promise<Uint8Array | undefined>;
  purgeStalePayloads(db: Db, now?: Date): Promise<number>;
  finishDelivery(db, input: { tenantId: string; userId: string; isoWeek: string; runId: string; state: "sent" | "empty" | "failed"; providerMessageId?: string; now: Date }): Promise<void>;
};
```

## apps/web (spec `_specs/weekly-digest.md`)

```ts
export type DigestGenerateEvent = {
  tenantId: string;       // UUID of the current household
  userId: string;         // recipient id
  scheduledAt: string;    // ISO-8601 UTC schedule boundary
  periodStart: string;    // inclusive ISO-8601 UTC
  periodEnd: string;      // exclusive ISO-8601 UTC
  isoWeek: string;        // ISO week YYYY-Www
};
export const digestGenerateEventSchema: z.ZodType<DigestGenerateEvent>;
export const DIGEST_GENERATE_EVENT = "neo/digest.generate";
export type PersonalDigestSlot = { verdictCounts: Array<{ label: VerdictLabel; count: number }>; topVerdicts: Array<{ id: string; label: VerdictLabel; headline: string; createdAt: string; href: string }> };
export type HouseholdDigestSlot = { alertCounts: Array<{ severity: Severity; count: number }>; topAlerts: Array<{ label: string; severity: Severity; createdAt: string; href: string }>; devices: { offline: number; removedOrUninstalled: number } };
export type BreachStatusSlot = { status: "clean" | "breached" | "not_checked"; href: string };
export type HardeningScoreSlot = { scorePercent: number | null; href: string };
export interface DigestRendererSlots { personal?: PersonalDigestSlot; household?: HouseholdDigestSlot; breachStatus?: BreachStatusSlot; hardeningScore?: HardeningScoreSlot }
export type DigestContent = DigestRendererSlots;
export type EnvSource = Readonly<Record<string, string | undefined>>;
export function renderWeeklyDigest(input: DigestContent, unsubscribeUrl: string, source?: EnvSource): { subject: string; html: string; text: string };
export interface OutgoingEmail { to: string; subject: string; html: string; text: string; idempotencyKey: string; headers?: Record<string, string> }
// Exact request bytes are encrypted at rest; plaintext is not returned in Inngest step state.
export type DigestSendPayload = { email: OutgoingEmail; role: "owner" | "member"; deliveryCreatedAt: string };
export function encryptDigestPayload(payload: DigestSendPayload, identity: { tenantId: string; userId: string; isoWeek: string }, env?: EnvSource): Uint8Array | undefined;
export function decryptDigestPayload(encrypted: Uint8Array, identity: { tenantId: string; userId: string; isoWeek: string }, env?: EnvSource): DigestSendPayload;
export interface Mailer { send(email: OutgoingEmail): Promise<{ id: string }> }
export interface SentEmail extends OutgoingEmail { from: string; id: string; sentAt: Date }
export class MailerHttpError extends Error { readonly status: number }
// Digest Resend requests are throttled to two per second; 408, 409, and 429 retry without terminalizing the ledger.
export type DigestPeriod = { scheduledAt: Date; periodStart: Date; periodEnd: Date; isoWeek: string };
export function digestPeriod(eventTs: number | undefined, firstStepReceivedAt: Date): DigestPeriod;
export const weeklyDigestCron = "TZ=UTC 0 14 * * 1";
export const DIGEST_RESUME_LEASE_MS = 15 * 60_000;
export function digestResendIdempotencyKey(userId: string, isoWeek: string): string; // digest:<userId>:<ISO week>
export interface WeeklyDigestStore {
  getPreference(tenantId: string, userId: string): Promise<boolean | undefined>;
  setPreference(tenantId: string, userId: string, enabled: boolean): Promise<boolean>;
  getDelivery(tenantId: string, userId: string, isoWeek: string): Promise<DigestDelivery | undefined>;
  claimDelivery(input: { tenantId: string; userId: string; isoWeek: string; periodStart: Date; periodEnd: Date; runId: string; now: Date }): Promise<{ result: "claimed" | "owned_live" | "terminal" | "household_move_collision"; delivery?: DigestDelivery }>;
  savePayload(input: { tenantId: string; userId: string; isoWeek: string; runId: string; payload: Uint8Array; now: Date }): Promise<boolean>;
  getPayload(input: { tenantId: string; userId: string; isoWeek: string; runId: string }): Promise<Uint8Array | undefined>;
  purgeStalePayloads(now?: Date): Promise<number>;
  finishDelivery(input: { tenantId: string; userId: string; isoWeek: string; runId: string; state: "sent" | "empty" | "failed"; providerMessageId?: string; now: Date }): Promise<void>;
}
export interface DigestRecipientStore { listDigestRecipientPairs(cursor?: string, limit?: number): Promise<{ items: Array<{ tenantId: string; userId: string }>; nextCursor?: string }> }
export interface DigestContentStore { loadDigestContent(input: { tenantId: string; userId: string; role: "owner" | "member"; periodStart: Date; periodEnd: Date }): Promise<DigestContent> }
export function createMemoryWeeklyDigestStore(): WeeklyDigestStore;
export function createMemoryDigestRecipientStore(): DigestRecipientStore;
export function createMemoryDigestContentStore(): DigestContentStore;
```

- `GET /api/settings/digest` → `{ enabled: boolean }`; `POST /api/settings/digest` `{ enabled: boolean }` → `{ enabled: boolean }` for the session user's own preference.
- `GET /api/digest/unsubscribe?token=v1.<payload>.<mac>` → read-only confirmation; `POST /api/digest/unsubscribe` `{ token }` → 204 and idempotently disables only the token owner's preference.
- `weeklyDigestCron` emits `neo/digest.generate` events using `DigestGenerateEvent`; recipient discovery returns IDs only, then re-resolves current membership and preference under tenant RLS.

Weekly-digest HTTP slices as built (2026-10-05):
- Settings GET requires an API session; POST requires a browser session and accepts only `{ enabled: boolean }`. Both resolve the session user's current tenant membership; a stale membership returns 403. Responses use `Cache-Control: no-store`.
- Unsubscribe GET returns a read-only HTML confirmation form. POST accepts the JSON contract, the confirmation form's token, or a query token with an RFC 8058 `List-Unsubscribe=One-Click` form body; success is 204 without a redirect, including removed memberships. All responses use `no-store` and `Referrer-Policy: no-referrer`; handlers do not log tokens or URLs.
- Unsubscribe GET and POST apply the process-local IP limiter only to malformed or invalid-HMAC requests, after token validation; valid tokens from shared IPs are not rate-limited. The limit is per app instance, not distributed.
- The exact email request is AES-GCM encrypted in `digest_deliveries.payload` using a tenant-derived key and `digest:<tenantId>:<userId>:<isoWeek>` AAD. It is never returned from the prepare step; only the current sending run can read/write it. Terminal completion clears it, and the daily retention job clears non-sending payloads plus sending payloads older than 24 hours; under the daily schedule, a sending payload may remain roughly 24–48 hours from creation. Deployed operation requires `NEO_MASTER_KEY`; when absent, digest preparation fails closed. Non-deployed/mock mode uses a development-only key.
- `AUTH_SECRET` rotation invalidates previously issued digest unsubscribe links; users must use a fresh link from a subsequent digest or change the setting in Settings.
- `list_digest_recipients` returns only verified recipients with enabled preferences; owner defaults are enabled and member defaults are disabled.
- Headline offline health is calculated at `periodEnd` (48-hour threshold), so retry time does not change content. Headlines redact URLs, emails, phone-like digit runs and long alphanumeric tokens; rendered text is escaped and unsafe links fall back to the dashboard.
- Resend digest sends are throttled to two requests per second; 408/409/429 and 5xx failures remain retryable, while other 4xx responses terminalize the delivery.
- Rendering requires HTTPS except `http://localhost` outside deployed environments.
## @neo/db (spec `_specs/breach-monitoring.md`)

```ts
export type VerificationSource = "sign_in" | "extra";
export type BreachCheckStatus = "never_checked" | "clean" | "breached" | "failed";
export type AddressRow = { id: string; tenantId: string; userId: string; digest: string; encryptedAddress: Uint8Array; verificationSource: VerificationSource; verificationTokenHash?: string; verificationExpiresAt?: Date; verifiedAt?: Date; verificationPending: boolean; checkStatus: BreachCheckStatus; lastCheckedAt?: Date; lastSuccessfulCheckAt?: Date };
// The table also stores up to three verification_send_times per tenant digest; timestamps are synchronized across same-digest rows.
export type BreachObservationInput = { breachName: string; domain?: string; breachDate?: Date; addedDate?: Date; dataClasses: string[]; retiredAt?: Date };
export type ObservationRow = BreachObservationInput & { id: string; tenantId: string; monitoredAddressId: string; firstSeenAt: Date; lastSeenAt: Date };
export type RequestVerificationResult = { status: "reserved" | "already_verified" | "rate_limited" | "address_limit"; address?: AddressRow };
export const breachMonitoring: {
  listAddresses(db: Db, tenantId: string, userId: string): Promise<AddressRow[]>;
  getAddressForCheck(db: Db, input: { tenantId: string; userId: string; addressId: string }): Promise<AddressRow | undefined>; // verified only
  addVerifiedAddress(db: Db, input: { tenantId: string; userId: string; addressId: string; digest: string; encryptedAddress: Uint8Array; verifiedAt: Date; now: Date }): Promise<AddressRow>;
  requestVerification(db: Db, input: { tenantId: string; userId: string; addressId: string; digest: string; encryptedAddress: Uint8Array; tokenHash: string; expiresAt: Date; now: Date }): Promise<RequestVerificationResult>; // atomically enforces 3 sends / rolling 24h and 5 extra addresses / user
  verifyAddress(db: Db, input: { tenantId: string; userId: string; tokenHash: string; verifiedAt: Date }): Promise<AddressRow | undefined>; // consumes single-use token only when unexpired
  removeAddress(db: Db, input: { tenantId: string; userId: string; addressId: string }): Promise<boolean>;
  deleteUserAddresses(db: Db, tenantId: string, userId: string): Promise<number>; // called by household leave/removal
  updateCheck(db: Db, input: { tenantId: string; userId: string; addressId: string; status: "clean" | "breached" | "failed"; checkedAt: Date }): Promise<boolean>;
  upsertObservations(db: Db, input: { tenantId: string; userId: string; addressId: string; observations: BreachObservationInput[]; now: Date }): Promise<{ newObservations: ObservationRow[] }>;
  listObservations(db: Db, input: { tenantId: string; userId: string; addressId: string }): Promise<ObservationRow[]>;
  listEligibleAddressIds(db: Db, opts?: { cursor?: string; limit?: number }): Promise<{ items: Array<{ tenantId: string; userId: string; addressId: string }>; nextCursor?: string }>;
  purgeExpiredVerificationTokens(db: Db): Promise<number>; // DB clock only; one batch of at most 1000
};
```

## apps/web (spec `_specs/breach-monitoring.md`)

```ts
export type HIBPBreach = { name: string; domain?: string; breachDate?: string; addedDate?: string; dataClasses: string[]; retired: boolean };
export type HIBPResult =
  | { status: "clean"; breaches: [] }
  | { status: "breached"; breaches: HIBPBreach[] }
  | { status: "retryable_failure"; retryAfterSeconds?: number }
  | { status: "configuration_failure" }
  | { status: "invalid_request" };
export function lookupBreachedAccount(email: string, deps?: HIBPDeps): Promise<HIBPResult>; // full v3 model, no raw body
export function breachMonitoringEnv(source?: EnvSource): { HIBP_API_KEY?: string; HIBP_RPM: number; HIBP_USER_AGENT: string }; // RPM 1..1000, default 10
export type BreachSurfaceStatus = "pending" | "clean" | "breached" | "stale" | "never-checked" | "failed";
export type BreachStatusObservation = { breachName: string; domain: string | null; breachDate: string | null; addedDate: string | null; dataClasses: string[]; firstSeenAt: string; lastSeenAt: string; retiredAt: string | null };
export type BreachStatusAddress = { id: string; email: string; source: VerificationSource; verificationStatus: "pending" | "verified"; status: BreachSurfaceStatus; verifiedAt: string | null; lastCheckedAt: string | null; lastSuccessfulCheckAt: string | null; observations: BreachStatusObservation[] };
export type BreachStatusSnapshot = { status: Exclude<BreachSurfaceStatus, "pending">; lastSuccessfulCheckAt: string | null; pendingCount: number; addresses: BreachStatusAddress[]; attribution: { label: "Have I Been Pwned"; url: "https://haveibeenpwned.com"; license: "CC BY 4.0" } };
export const BREACH_STATUS_STALE_AFTER_MS: number; // 8 days from last success
export type BreachCheckTarget = { tenantId: string; userId: string; addressId: string };
export const BREACH_CHECK_EVENT = "neo/breach-monitoring.check";
export type BreachCheckEvent = { id: string; name: typeof BREACH_CHECK_EVENT; data: { attempt: number; targets: BreachCheckTarget[] } };
// Event ID: `neo/breach-monitoring.check:<UTC run date>:<tenantId>:<addressId>` of the group's lexicographically first target (+ `:retry-<n>` on retries). No address-derived value (including the global digest) is in an event ID or payload; data holds identifiers and attempt.
// `lookupBreachedAccount`: GET breachedaccount/{email}?truncateResponse=false&IncludeUnverified=false; validates only the fields used (Name, Domain?, BreachDate, AddedDate, DataClasses, IsRetired) and ignores unknown fields. Mock fixtures (@example.com breached, else clean, no network) when MOCK_MODE or (no HIBP_API_KEY and not deployed); deployed without a key -> configuration_failure, no request.
export const BREACH_MONITORING_WEEKLY_CRON = "0 15 * * 1";
export const BREACH_TOKEN_CLEANUP_CRON = "0 4 * * *";
export const breachMonitoringCron: InngestFunction;
export const breachCheck: InngestFunction; // function-wide HIBP_RPM throttle and per-event ID concurrency, `retries: 1`; each provider retry is a new throttled run. `checkGroup(targets)` does exactly one lookup per group. The cron runs discovery, event build and `inngest.send` inside one `step.run` that returns only `{ queued }`
export const breachVerificationCleanup: InngestFunction;
export function getBreachStatusForUser(input: { tenantId: string; userId: string }): Promise<BreachStatusSnapshot>; // may idempotently seed verified sign-in row; never queries HIBP
export const checkBreachesTool: RegisteredTool; // empty strict input; only session subject; result goes through wrapToolResult
export function deriveMonitoredAddressDigest(tenantId: string, address: string, source?: EnvSource): Promise<string>; // deriveKey(masterKey, "neo-breach-addr-v1", tenantId), then HMAC-SHA256
export function deriveGlobalBreachQueryDigest(address: string, source?: EnvSource): Promise<string>; // deriveKey(masterKey, "neo-breach-global-v1", ""); in-process single-flight grouping only, never sent to Inngest or persisted. Without NEO_MASTER_KEY a deterministic dev key is used only when `!isDeployedEnvironment()`; deployed fails closed (all breach crypto)
export function encryptMonitoredAddress(address: string, identity: { tenantId: string; userId: string; addressId: string }, source?: EnvSource): Uint8Array;
export function decryptMonitoredAddress(encrypted: Uint8Array, identity: { tenantId: string; userId: string; addressId: string }, source?: EnvSource): string;
export function issueVerificationToken(): string; // cryptographically random 256-bit value, returned only to email sender
export function hashVerificationToken(token: string): string; // SHA-256 hex, only hash stored
export const BREACH_ALERT_KIND = "breach_detected";
export function alertBreachDetected(input: { tenantId: string; userId: string; addressId: string; breachName: string; dataClasses: string[] }): Promise<void>;
// GET /api/settings/breaches/addresses -> { addresses, maxExtraAddresses: 5 }
// POST /api/settings/breaches/addresses { email } -> 202 { status: "pending_confirmation" }
// DELETE /api/settings/breaches/addresses/[id] -> 204; only extra addresses can be removed
// POST /api/settings/breaches/addresses/verify { token } -> { status: "verified" }
// GET /api/settings/breaches -> session user's statuses, last successful check, selected observations, and HIBP attribution
// Settings page: /settings/breaches; email confirmation page: /settings/breaches/verify (no-referrer; explicit click required)
// All breach status and address APIs require a browser session; only the address owner receives decrypted address strings.
```

Address CRUD and status reads take tenant/user identity from the authenticated session, never request input; API responses are `Cache-Control: no-store`. The verified sign-in address is initialized from `users.email` only when `emailVerified` is non-null and cannot be removed through the extra-address DELETE endpoint. Extra addresses require confirmation and can be removed. Household leave/removal hard-deletes addresses and observations. Owner alert email subject/body contains the breach name and static guidance only, never the address; it uses existing owner thresholds and email caps. The chat tool accepts an empty object and reports stored status only; the agent wraps its result with `wrapToolResult`.

---

## @neo/core (spec `_specs/hardening-score.md`)

```ts
// Pure and deterministic (no model, no I/O). The types below are defined here and re-exported by @neo/db.
export type AccountHardeningVersion = "account-hardening-v1";
export type AccountHardeningItemId = /* the ten ids listed under @neo/db */ string;
export type AccountHardeningState = "complete" | "needs_action" | "unanswered" | "stale" | "unknown" | "not_applicable";
export interface AccountHardeningManifestItem { id: AccountHardeningItemId; source: "self_attested" | "neo_data"; weight: number; title: string; rule: string; action: string; notApplicableWhen?: string; compatiblePriorVersions: readonly AccountHardeningVersion[]; helpLinks: readonly { provider: string; href: string }[] }
export interface AccountHardeningManifest { version: AccountHardeningVersion; items: readonly AccountHardeningManifestItem[] }
export const ACCOUNT_HARDENING_V1: AccountHardeningManifest; // immutable once shipped
export const CURRENT_ACCOUNT_HARDENING_VERSION: AccountHardeningVersion; export const CURRENT_ACCOUNT_HARDENING_MANIFEST: AccountHardeningManifest;
export function scoreAccountHardening(input: { answers: readonly { itemId: AccountHardeningItemId; value: boolean | "not_applicable"; checklistVersion: AccountHardeningVersion; answeredAt: Date }[]; evidence: Partial<Record<"forwarding_used_30d" | "browser_extension_enrolled" | "desktop_agent_enrolled", "complete" | "needs_action" | "unknown">>; asOf: Date; manifest?: AccountHardeningManifest }): AccountHardeningScore; // same shape as the apps/web interface below
export function isAccountHardeningItemId(value: unknown): value is AccountHardeningItemId;
export function isAccountHardeningAnswerAllowed(itemId: unknown, value: unknown): value is boolean | "not_applicable"; // true/false only for self-attested items; not_applicable only where notApplicableWhen is set
```

Scoring rules beyond the spec text: a stale answer (including a stale `not_applicable`) still counts as "answered" for the three-answer threshold; only the seven self-attested items count toward it; a detected item with missing evidence is `unknown`; `not_applicable` on `desktop_agent_enrolled` applies only while the detection is not `complete`. Missing `scorePercent` (null) also covers a known denominator of zero.

## @neo/db (spec `_specs/hardening-score.md`)

```ts
export type AccountHardeningVersion = "account-hardening-v1";
export type AccountHardeningItemId = "primary_email_2fa" | "passkey_or_hardware_key" | "recovery_contacts_current" | "password_manager" | "carrier_port_out_pin" | "credit_freeze" | "os_browser_auto_update" | "forwarding_used_30d" | "browser_extension_enrolled" | "desktop_agent_enrolled";
export type AccountHardeningState = "complete" | "needs_action" | "unanswered" | "stale" | "unknown" | "not_applicable";
// Table `account_hardening_answers` (migration 0014): PK (tenant_id, user_id, item_id); FK (tenant_id, user_id) -> memberships ON DELETE CASCADE
// (leaving, removal, or joining another household deletes the answers); `answer` boolean null when `not_applicable`; check constraints limit
// item ids and N/A to credit_freeze, carrier_port_out_pin, desktop_agent_enrolled (desktop_agent_enrolled accepts only N/A).
// Registered in tenantTables, protected by tenant_isolation RLS, granted SELECT/INSERT/UPDATE/DELETE to app_user. No SECURITY DEFINER function.
// set() throws for a non-answerable item/value; evidence reads inbound_messages.forwarder_user_id and non-revoked devices in the tenant only.
export interface AccountHardeningAnswer { tenantId: string; userId: string; itemId: AccountHardeningItemId; value: boolean | "not_applicable"; checklistVersion: AccountHardeningVersion; answeredAt: Date }
export const accountHardening: { getAnswers(db: Db, tenantId: string, userId: string): Promise<AccountHardeningAnswer[]>; getEvidence(db: Db, tenantId: string, userId: string, asOf: Date): Promise<Record<"forwarding_used_30d" | "browser_extension_enrolled" | "desktop_agent_enrolled", "complete" | "needs_action" | "unknown">>; set(db: Db, answer: Omit<AccountHardeningAnswer, "answeredAt">, now?: Date): Promise<AccountHardeningAnswer>; clear(db: Db, tenantId: string, userId: string, itemId: AccountHardeningItemId): Promise<boolean> };
```

## apps/web (spec `_specs/hardening-score.md`)

```ts
export interface AccountHardeningScore { checklistVersion: AccountHardeningVersion; asOf: string; scorePercent: number | null; partial: boolean; items: Array<{ id: AccountHardeningItemId; state: AccountHardeningState; weight: number; answeredAt: string | null }>; nextActions: AccountHardeningItemId[] }
export function loadAccountHardeningScore(session: NeoSession, asOf?: Date): Promise<AccountHardeningScore>;
export function loadHouseholdHardeningPercents(session: NeoSession): Promise<Array<{ userId: string; scorePercent: number | null }>>; // owner only; members receive 403
export function setAccountHardeningAnswer(session: NeoSession, input: { itemId: AccountHardeningItemId; checklistVersion: AccountHardeningVersion; value: boolean | "not_applicable" }): Promise<AccountHardeningScore>;
export function clearAccountHardeningAnswer(session: NeoSession, itemId: AccountHardeningItemId): Promise<AccountHardeningScore>;
```

- The score shows `scorePercent: null` ("not enough answers") until at least 3 self-attested items have a fresh answer (`complete`, `needs_action`, `not_applicable`; `stale` does not count). `forwarding_used_30d` counts attributed inbound messages in the rolling 30 days of any status except `rejected`. Answering without a membership row is 403 `forbidden`. The weekly digest treats only personal/household activity as reportable; the score rides along when a week is sent.
- Errors are `HardeningScoreError { status, code }` (`forbidden` 403, `storage_unavailable` 503, `checklist_version_mismatch` 409, `invalid_request` 400); routes map them to `{ error, code }` JSON. Evidence and answers are read through a `HardeningStore` (Postgres via @neo/db, or `memory-hardening.ts` without a database). The weekly digest fills `HardeningScoreSlot` with the recipient's own percentage and `/settings/hardening`, omitted while the percentage is null or unreadable. Pages: `/settings/hardening` (own checklist only) and a dashboard card (owners also see other members' percentages).
- `GET /api/hardening-score` → personal score. `POST /api/hardening-score/answers` `{ itemId, checklistVersion, value: boolean | "not_applicable" | "clear" }` → updated personal score; `clear` removes that answer. This is the only answer mutation route. A stale checklist version returns 409 `checklist_version_mismatch`; session identity selects the subject; answer mutation requires a browser session.

---

## @neo/verdict (spec `_specs/signin-alerts.md`)

```ts
export const SIGNIN_ALERT_PROVIDERS: readonly ["google", "microsoft", "apple", "meta", "amazon", "paypal"];
export const SIGNIN_ALERT_EVENTS: readonly ["new_signin", "new_device", "password_changed", "mfa_or_recovery_changed", "suspicious_activity"];
export type SigninCheck = { provider: SignInAlertProvider; event: SignInAlertEvent; device_label: string /* 1..80 */; first_seen: boolean; coarse_location?: string /* max 80, the parser's bounds */ };
export type Verdict = { /* existing fields */ signin_check?: SigninCheck };
```

`signin_check` is the stored verdict data for the "Was this you?" question. It is written only by the sign-in alert hook; it is removed from `verdictJsonSchema` (the model is never offered it) and the chat path strips any `signin_check` a model emits inside `extractVerdict` (whether or not `analyze_email` ran; `extractModelVerdict` returns the raw block) and the inbound path via `finalizeSigninVerdict`. `coarse_location` is advisory.

## @neo/tools (spec `_specs/signin-alerts.md`)

```ts
export type SignInAlertProvider = "google" | "microsoft" | "apple" | "meta" | "amazon" | "paypal";
export type SignInAlertEvent = "new_signin" | "new_device" | "password_changed" | "mfa_or_recovery_changed" | "suspicious_activity";
export type SignInAlert = { template_id: string; provider: SignInAlertProvider; event: SignInAlertEvent; event_time?: string; location?: string; ip_addresses: string[]; device?: string; account_hint?: string; evidence: { field: "subject" | "sender" | "body"; excerpt: string }[]; warnings: string[]; analyzed_at: string;
  reply_with_code?: true;   // set by analyzeEmail: "reply with the code" in the first 200k chars of the full text, or a mailto: link that asks for a code
  mailto_links?: number };  // mailto: links in the message (set when > 0)
export type EmailAuthentication = { /* existing fields */ dkim_domains: string[]; dkim_pass_domains: string[] /* d= of PASSING signatures only; [] in the DKIM-Signature fallback */; strict?: { spf; dkim; dkim_pass_domains: string[]; dmarc; aligned: boolean | null; untrusted: boolean } /* sign-in gates only: the one selected Authentication-Results header, never merged; untrusted when no Received `by` host matched its authserv-id or a header sits above it */ };
export type EmailAnalysis = { /* existing fields */ link_summary?: { hosts: string[] /* unique hosts of ALL http(s) candidates, cap 500 */; hosts_truncated: boolean; unlisted: number /* candidates beyond the 50 listed urls */; nonstandard: number /* userinfo or port */; non_web: number } };
export type EmailAnalysis = { /* existing fields */ signin_alert?: SignInAlert };
export const SIGNIN_ALERT_SENDERS: Readonly<Record<SignInAlertProvider, readonly string[]>>;
export const SIGNIN_ALERT_DOMAINS: Readonly<Record<SignInAlertProvider, readonly string[]>>; // registrable domains allowed for DKIM d= and links
export const SIGNIN_ALERT_LINK_HOSTS: Readonly<Record<SignInAlertProvider, readonly string[]>>; // exact link hosts for the likely_safe gate; verify against real alerts before verifying templates
export const SIGNIN_ALERT_TEMPLATES: readonly { id: string; provider: SignInAlertProvider; event: SignInAlertEvent; verified: boolean }[];
export type SigninFakeRule = "sender_provider_mismatch" | "off_provider_link" | "callback_number" | "reply_with_code";
export function assessSigninAlert(a: EmailAnalysis, templates?: readonly { id: string; verified: boolean }[]): SigninAlertAssessment | null; // fake rules, auth_absent, authenticated, safe gates
```

`analyzeEmail` fills `signin_alert` from the already-parsed message (no separate analyze function). `parseSigninAlert` returns null for unknown, conflicting-provider, ambiguous or non-English messages. Rule 4 fires on `signin_alert.reply_with_code` (full text, bounded, or a mailto: link asking for a code), the existing `credential_request` signal, or the phrase in the excerpt.

Safe gates (`assessSigninAlert().gates`; every one is required for `likely_safe`): `template_verified`; `sender_exact` (From address equals a listed `SIGNIN_ALERT_SENDERS` address, entries without `@` are pre-filter domains only); `dkim_pass` and `dkim_domain_allowlisted` (a PASSING signature's d= on the provider allowlist; a failing signature never counts) and `dkim_aligned` (a passing d= has the From registrable domain, or `aligned` with `dmarc=pass`), all read only from `authentication.strict` (the single selected Authentication-Results header, no merging with lower headers; `untrusted` fails the gates) and only when `authentication.source === "authentication_results"`; `links_on_provider` (registrable domains; runs over `link_summary.hosts`, so links beyond the 50 listed urls count, and an incomplete host list fires `off_provider_link`); `link_hosts_exact` (every candidate host is in `SIGNIN_ALERT_LINK_HOSTS`, none unlisted, no userinfo, port or non-web scheme, no mailto: link; `<button formaction>`, `<input formaction>` and `<a ping>` count as links); `no_injection`. Authentication that comes only from ARC, Received-SPF or DKIM-Signature headers (attacker-writable) counts as absent (`auth_absent`, so the `insufficient_evidence` path). A link on another host of the provider's registrable domain (sites.google.com, docs.google.com) fails the gate without being a fake-alert signal.

## @neo/db (spec `_specs/signin-alerts.md`)

```ts
// Migration 0015. Both tables are in tenantTables with tenant_isolation RLS and app_user grants; both cascade with the (tenant_id, user_id) membership.
signin_events: { id; tenant_id; user_id; provider; event; device_label (nullable); coarse_location; event_time; source: "forwarded" | "outlook"; authenticated: boolean; verdict_id (cascade with the verdict); created_at };
known_signin_devices: { id; tenant_id; user_id; provider; device_label; first_seen_at; last_seen_at; UNIQUE (tenant_id, user_id, provider, device_label) };
type SigninEvent = { /* signin_events row */ deviceKnown: boolean };
tenantScoped(db, tenantId).signinEvents.list(userId, opts?): Promise<SigninEvent[]>;      // newest first, default 50, max 200
tenantScoped(db, tenantId).signinEvents.record(input): Promise<SigninEvent>;
tenantScoped(db, tenantId).signinEvents.isKnownDevice(userId, provider, deviceLabel): Promise<boolean>;
tenantScoped(db, tenantId).signinEvents.rememberDevice(userId, provider, deviceLabel): Promise<void>;
tenantScoped(db, tenantId).signinEvents.forgetDevice(userId, provider, deviceLabel): Promise<void>;
tenantScoped(db, tenantId).signinEvents.deleteForUser(userId): Promise<number>;
```

## apps/web (spec `_specs/signin-alerts.md`)

```ts
export interface GeoLocator { locate(ip: string): Promise<{ coarseLocation?: string; advisory: true }> }
export const mockGeoLocator: GeoLocator;
export const reviewMySigninsTool: RegisteredTool; // "review_my_signins"; input { provider?: "" | provider; limit?: 1..50 }, blanks and null are absent
// Registered through createToolRegistry in buildToolRegistry (apps/web/lib/server/agent-run.ts).
export function applySigninAlertOverride(input: { analysis: EmailAnalysis; verdict: Verdict }): Verdict;
export function finalizeSigninVerdict(input: { tenantId; userId; analysis; verdict; source }): Promise<{ verdict: Verdict; event: SigninEventPayload | null }>; // override + signin_check (first_seen); stores nothing
export function persistSigninEvent(input: { tenantId; userId; verdictId?; event }): Promise<void>;   // never throws
export type StoredSigninVerdictData = { signin_check?: SigninCheck };
export const PLAYBOOK_IDS: readonly [..., "account_takeover"];
// apps/web/lib/server/playbooks/account_takeover.md added; generated.ts regenerated (pnpm --filter @neo/web playbooks:generate).
```

Hook placement: inbound job step `signin-alert` between `triage` and `save-verdict` (event stored in `save-verdict` once the verdict has an id); chat path in `streamAgentRun` after `extractVerdict` and before `appendTurn`/`saveChatVerdict`, using the `analyze_email` result in that turn's messages (falling back to a copy captured when the tool ran, if the stored result was truncated). When a rule changes anything visible (label, headline, indicators, actions) the stored message's last valid verdict block is rewritten (`replaceLastVerdict` in `lib/verdict-fence.ts`, the same fence scan as `splitVerdictSegments`/`extractVerdict`), a `verdict_override` event is streamed (the client rewrites the card it rendered from the model's text, even though `done` already arrived), then one note line is appended and streamed. `signin_check` is never in the text or the event.

Several emails in one chat turn (`selectSigninAnalysis`): one analysis uses it; several use the one whose subject, sender or link hosts the verdict quotes when exactly one does (no override if that one is not a sign-in alert); otherwise, when any is a sign-in alert, the choice is ambiguous and `applyAmbiguousSigninCap` runs: `likely_safe` becomes `suspicious`, other labels are kept, static headline, `subject_type: "signin_alert"`, no `signin_check`, no event. A model-claimed `signin_alert` subject with no alert analysis gets the same cap. If the hook itself throws and the turn touched a sign-in alert (or the verdict claims that subject), `applySigninHookFailureCap` applies the same cap (static headline, error logged without content) and a `verdict_override` is emitted; the inbound job does the same for a recognized alert (a throw on any other message still fails the step).

Owner privacy (`lib/server/signin/privacy.ts`): for a `signin_alert` verdict viewed by anyone but its own user, `verdictDetail`, the verdict list headline, the `verdictId` chat context, the owner chat entry message and owner alert text replace `headline` with static text by label, every indicator's `evidence`/`explanation` and `recommended_actions` with generic text (category kept only when plain snake_case), drop `iocs.ips`, reduce `iocs.urls` to origins and remove `signin_check`. Stored override headlines are static for the same reason.

Outcomes (`applySigninAlertOverride`): a fake-alert rule fires -> `malicious`; verified template + every safe gate above (and the triage verdict is not `malicious`) -> `likely_safe`; no authentication results (forwarded wrapper, pasted) -> `insufficient_evidence` (a `suspicious` or `malicious` triage verdict is kept); otherwise the triage verdict with `likely_safe` capped to `suspicious`. A fake alert gets no `signin_check`. Owners never receive `signin_check` in verdict detail.

- `POST /api/verdicts/[id]/signin-response` `{ response: "yes" | "no" }` -> 200 `{ ok: true, playbook?: "account_takeover" }`; browser session only (desktop token 403); only the verdict's own user may answer (404 otherwise, owners included); last answer wins (yes remembers the provider/device pair, no forgets it); 409 `no_signin_check` if the verdict has no `signin_check`; `no` returns the `account_takeover` playbook id; 400 for any other body.
- `GET /api/verdicts/[id]` adds `signinDeviceKnown?: boolean` (own verdicts with a first-seen check only).

---

## @neo/db (spec `_specs/outlook-connector.md`)

```ts
// Register in tenantTables; tenant_isolation RLS and app_user grants (or create-app-user.sql defaults).
Export distinct credentials from the shared helper using the approved labels `neo-connector-oauth-state-v1`, `neo-connector-v1`, and `neo-connector-cursor-v1`, with the tenant id passed as context.
// Migration number is next free at implementation time.
export type OutlookOAuthState = { id: string; tenantId: string; userId: string; stateHash: Uint8Array; encryptedPkceVerifier: Uint8Array; expiresAt: Date; consumedAt?: Date };
// UNIQUE state_hash; INDEX expires_at; UNIQUE connector (tenant_id,user_id); UNIQUE finding (tenant_id,connector_id,rule_key).
outlook_oauth_states: { id; tenant_id; user_id; state_hash; encrypted_pkce_verifier; expires_at; consumed_at; created_at };
outlook_connectors: { id; tenant_id; user_id; microsoft_user_id; display_address; status; token_version; connection_generation; encrypted_tokens; encrypted_delta_cursor; last_audit_at; last_poll_at; created_at; updated_at };
outlook_rule_findings: { id; tenant_id; user_id; connector_id; rule_key; state; action; destination_domain; observed_at; resolved_at; alerted_at };
outlook_seen_messages: { tenant_id; connector_id; message_key; seen_at };  // PK (connector_id, message_key)
tenantScoped(db, tenantId).outlookConnectors.get(userId): Promise<OutlookConnector | undefined>;
tenantScoped(db, tenantId).outlookOAuthStates.create(input): Promise<OutlookOAuthState>;
tenantScoped(db, tenantId).outlookOAuthStates.consume(stateHash, userId, now): Promise<OutlookOAuthState | undefined>;
tenantScoped(db, tenantId).outlookConnectors.compareAndSwapTokens(id, expectedVersion, ciphertext): Promise<boolean>;
tenantScoped(db, tenantId).outlookConnectors.updateCursor(id, generation, cursorCiphertext): Promise<boolean>;  // fenced: status 'connected' and connection_generation = generation
tenantScoped(db, tenantId).outlookRuleFindings.upsert(input): Promise<OutlookRuleFinding>;
```

## apps/web (spec `_specs/outlook-connector.md`)

```ts
export type OutlookConnectorStatus = "connected" | "reauth_required" | "paused" | "disconnected";
export interface OutlookGraphClient { getMe(signal?: AbortSignal): Promise<GraphMe>; listInboxRules(nextLink?: string, signal?: AbortSignal): Promise<GraphRulePage>; getInboxDelta(input: { nextLink?: string; deltaLink?: string; signal?: AbortSignal }): Promise<GraphDeltaPage>; getCandidateMessage(id: string, signal?: AbortSignal): Promise<GraphMessage> }
export const OUTLOOK_FORWARDING_ALERT_KIND = "mailbox_forwarding";
```

- `POST /api/connectors/outlook/start`; `GET /api/connectors/outlook/callback`; `GET /api/connectors/outlook`; `DELETE /api/connectors/outlook` (same-origin).
- `auditOutlookRules(ctx: { tenantId; userId; connectorId }): Promise<void>`; `pollOutlookInbox(ctx: { tenantId; userId; connectorId }): Promise<void>`.
- `SIGNIN_ALERT_SENDERS` from `_specs/signin-alerts.md`; parsed events use the table defined by `_specs/signin-alerts.md`.

### As built: Outlook connector (migration 0023)

- Tables as above; `outlook_oauth_states.state_hash` and the `encrypted_*` columns are `bytea`. Connectors are never deleted on disconnect: `status = 'disconnected'`, token and cursor ciphertext set to NULL (so findings keep their connector). `reauth_required` also nulls both. `UNIQUE (tenant_id, id)` on connectors backs the findings FK. `connection_generation` starts at 1 and is bumped by `upsertConnected`, `disconnect` and `markReauthRequired` (never by a token refresh, which only bumps `token_version`); `updateCursor`, `touch` and `outlookSeenMessages.claim` write only while the row is `connected` at the caller's generation. `outlook_seen_messages.message_key` is a hex HMAC-SHA256 of the Graph message id (`neo-connector-msgid-v1`, per-tenant key); `claim` is insert-if-absent and returns true only on first sight; the daily audit purges keys older than 45 days and `disconnect` deletes them. `outlook_rule_findings.alerted_at` is set only after the owner alert succeeded or was skipped by policy; re-activation clears it. `outlook_rule_findings.rule_key` is a SHA-256 hex digest of rule id, action and destination domain; `action` is `forward_to | redirect_to | forward_as_attachment_to`, `state` is `active | resolved`; `observed_at` is the first observation of the current activation.
- No baseline column: the 30-day baseline state, the `since` floor and the pending-page `done` ids live inside the encrypted cursor JSON `{ kind: "next" | "delta", link, baselineComplete, since, done? }` (label `neo-connector-cursor-v1`). Baseline pages advance the cursor without fetching any message and raise nothing.
- `SECURITY DEFINER public.list_outlook_connectors(uuid, text, integer)` (cron discovery, `connected` only, ids only); EXECUTE revoked from PUBLIC and granted to `app_user` in the migration and in `create-app-user.sql`. `outlookScheduler.listConnected(db, { cursor?, limit? })` wraps it.
- Extra tenant-scoped methods: `outlookConnectors.{getById, listSummaries, upsertConnected, markReauthRequired, touch(id, generation, patch): Promise<boolean>, disconnect}`, `outlookOAuthStates.purge`, `outlookRuleFindings.{list, resolveMissing, listUnalerted(connectorId), markAlerted(id, at)}`, `outlookSeenMessages.{claim(connectorId, generation, messageKey, now): Promise<boolean>, release, purge(connectorId, before)}`; `outlookRuleFindings.upsert` returns the row plus `created` (new activation). `outlookOAuthStates.create` takes the caller's `id` (it is part of the AAD).
- `OutlookGraphClient.getInboxDelta` also takes `since?: Date` (first request `$filter=receivedDateTime ge`). `pollOutlookInbox(ctx, deps)` returns `{ status: "ok" | "skipped" | "reauth_required" | "rate_limited" | "reset", pages, candidates, retryAfterSeconds? }` instead of `void` so Inngest can sleep (capped at 3600 s); `auditOutlookRules(ctx, deps)` returns `{ status, findings, raised }` (`raised` counts alerts newly sent, including retries of earlier failures) and re-raises active findings with `alerted_at IS NULL`. Candidates are analysed with `maxUrls: 0`: mail links are never fetched. `alertMailboxForwarding` returns `"raised" | "exists" | "skipped" | "failed"` (only `failed` leaves `alerted_at` null). Inngest `outlook-poll` and `outlook-audit` run with concurrency `[{ limit: 3, key: tenantId }, { limit: 1, key: connectorId }]`. Own addresses are Graph `mail` and `userPrincipalName` only; a non-plain destination address is indeterminate (external).
- Routes: `POST /start` (browser session + same-origin; 503 `connector_unavailable` when off) returns `{ authorizeUrl }`; `GET /callback` (browser session; 404 when off) answers 303 to `/settings/outlook?connect=connected|denied|invalid_state|failed` (absolute URL built from `APP_URL`, never `req.url`); `GET /api/connectors/outlook` returns the status view (always 200, `mode: "live" | "mock" | "off"`); `DELETE` (browser session + same-origin; works when off) returns `{ ok, disconnected, appAccessUrl }`.
- Mode: `outlookEnv().mode` is `mock` for MOCK_MODE on a non-deployed environment (fake authorize/callback and fixture mailbox, never Microsoft), `live` only when all three `OUTLOOK_*` vars and `NEO_MASTER_KEY` are set, else `off`.
- Authenticated connector alerts get a deterministic baseline verdict (no model call, no usage) through `finalizeSigninVerdict({ source: "outlook" })`, saved with verdict source `inbound` (no new verdict source); unauthenticated ones only `persistSigninEvent` (`authenticated: false`, no verdict).
- Events `neo/outlook.poll` and `neo/outlook.audit` (`{ tenantId, userId, connectorId }`), crons `*/15 * * * *` and `17 5 * * *`; alert `mailbox_forwarding` is raised for members only, dedupe key `mailbox_forwarding:<findingId>:<observedAt ms>`.

# Package contracts (v2, planned)

Planned, not built. Spec `_specs/v2-architecture.md`, plan `_plans/v2.md`. Every change here is additive: shipped desktop and extension builds keep working against the v2 server.

## @neo/db (M1)

- `members` (`id`, `tenant_id`, `user_id` nullable and unique per tenant, `display_name`, `role` `owner|adult|child|elder`, `mode` `standard|child|elder`, `birth_year?`, `helper_member_ids uuid[]`, encrypted `contact`, timestamps); tenant RLS, in `tenantTables`, granted to `app_user`. Backfilled one per `memberships` row (`owner` → `owner`, `member` → `adult`, mode `standard`).
- `eve_sessions` (`session_id` PK, `tenant_id`, `user_id`, `created_at`): the owner of each eve agent session (migration 0019).
- `devices.member_id` (backfilled from `user_id`); `device_enrollment_codes.member_id`. `devices.user_id` becomes nullable in a later migration.
- `policies` (`tenant_id`, `scope` `household|member|device`, `scope_id`, `version`, `rules` jsonb, `created_by`, `created_at`), append-only.
- `alerts` gains `member_id`, `status` `open|acknowledged|resolved|false_positive` (backfilled from `acknowledged_at`), `signal_ids uuid[]`, `eve_session_id`, `resolved_at`. An alert is the v2 "incident".
- `incident_actions` (`alert_id`, `kind`, `requested_by` `agent|admin`, `approved_by`, `status`, `result`, timestamps).
- `notification_outbox` (`tenant_id`, unique `idempotency_key`, `channel`, `destination`, `template`, `payload` jsonb, `attempts`, `lease_until`, `sent_at`, `provider_id`, `last_error`).
- Migration numbers: 0016 was held for the Outlook connector (#50). v2 took 0017 (members), 0018 (outbox sweep), 0019 (eve sessions), 0020 (member-only devices), 0021 (child policy), 0022 (policy bundles) and 0023 (Outlook connector, #50, journal `when` `1793632926799`) and 0024 (child request tokens, journal `when` `1793632986799`).

## @neo/verdict and @neo/core (M1)

```ts
// @neo/verdict
PROTECTION_MODES = ["standard", "child", "elder"];
PolicyRulesSchema: z.ZodType<PolicyRules>;           // all optional, no defaults, unknown keys stripped: web, apps, screenTime (M2, below), remote_access { unknownPeerSeverity, sessionWindowMinutes }, payments { underPressureWindowMinutes }, notify { helpersNotifyAt, ownersNotifyAt, childRequestsTo }, devices { protectionDisabledSeverity }
type ServerSignalEvent = { id: string; detector: "protection_disabled"; reason: "extension_uninstalled" | "device_offline"; observedAt: string };   // never client-accepted; not in SIGNAL_DETECTORS
// @neo/core (no @neo/db or @neo/tools import: catalog facts are injected)
MODE_DEFAULTS: Record<ProtectionMode, PolicyRules>;   // standard = today's rules (correlation rules off: windows unset); child = childDefaults("10_13"); elder per _specs/v2-m1-elder.md §4
effectivePolicy({ household?, mode, member?, device?, birthYear?, timeZone?, now? }) → PolicyRules;   // household → mode defaults → member → device; invalid layers skipped; birthYear/timeZone/now pick the age band for mode child only
evaluateSignal(
  policy: PolicyRules,
  input: { event: SignalEvent | ServerSignalEvent; signalId?: string; enrichment?: { label: "malicious" | "suspicious" | "clean" | "failed"; severity?: Severity; reasonCodes?: string[] } },
  ctx: { now: Date; deviceId: string; expectedTools: { toolId; peerIds }[]; recent: RecentSignal[]; catalog: { vendorDomains(toolId): string[]; toolIdForBundle(bundleId): string | undefined } },
) → Decision;   // pure: no I/O, no model, no clock
type Decision = {
  action: "record" | "dismiss" | "incident" | "escalate" | "reject";
  kind: "scam_page" | "dangerous_site" | "remote_access" | "unwanted_software" | "permission_grant" | "install_during_session" | "payment_under_pressure" | "protection_disabled" | "self_harm_attempts" | "app_approval" | null;
  severity: Severity | null;
  verdictLabel: "malicious" | "suspicious" | null;
  reasonCodes: string[];
  rejectReason?: "relates_to_unknown";
  bypassOf?: { relatesTo: string; relatedVerdictId: string | null; relatedAlertKind: string | null };
  notifyNow: boolean;      // incident severity >= min(notify.ownersNotifyAt, notify.helpersNotifyAt), default "high"; per-owner alert_email_threshold still filters recipients
  escalate: boolean;       // action === "escalate"
  correlations: { kind: "scam_in_progress" | "install_during_session" | "payment_under_pressure"; severity: "critical"; bucket: string /* 30-min UTC; dedupe <kind>:<userId>:<bucket> */; signalIds: string[]; events: { id; deviceId; kind; severity; observedAt }[]; notifyNow: boolean }[];   // one alert each; empty unless action === "incident"
};
```

## apps/web (M1–M2)

- `POST /api/signals` evaluates each accepted event with `evaluateSignal` inline; `incident` decisions create or update an alert and, when `notifyNow`, outbox rows in the same transaction. Standard-mode decisions, kinds and dedupe keys are unchanged.
- `signal-escalate` stays (M1) as reputation enrichment: on a lookup result it re-runs `evaluateSignal` with `enrichment` and applies that decision. It moves in M3.
- `alert-created` keeps its id and event (`neo/alert.created`) but now drains the notification outbox, plus an `outbox-sweep` cron (every 5 minutes). Recipients (pure `resolveAlertRecipients`): owners by `alert_email_threshold` (unchanged), plus the subject member's helpers (`helper_member_ids`) at or above `notify.helpersNotifyAt` when the subject is in Elder or Child mode (a helper uses their account email, else the decrypted `contact`; neither means skipped); deduped by lowercased address, owners first. **Self-exclusion applies only to Elder/Child subjects:** such a member is never a recipient about their own alert, even if they are an owner; a Standard-mode owner still gets alerts about their own devices. Outbox key `alert:<alertId>:<recipientMemberId>` (`alert:<alertId>:u:<userId>` for an owner with no member row); Resend idempotency key (in `payload.resendKey`) unchanged for account holders (`alert:<alertId>:<userId>`), `alert:<alertId>:m:<memberId>` for contact-only helpers. Helper emails name the member ("Gran's laptop") and a critical one starts "Stop, hang up, and call Gran." (templated only).
- Cap: 20 alerts per household per UTC day, decided at enqueue. The count is of other alerts created that day with `email_status` `pending` or `sent` (alerts, not emails; counting at enqueue so a burst cannot pass it before the first drain), serialized per household by an advisory lock. Over the cap a non-critical alert is marked `skipped` and the owners get one `alert_cap` notice (key `alert-cap:<tenant>:<date>:<userId>`, `ON CONFLICT DO NOTHING`). Critical alerts are exempt, and so are `child_request` and `app_approval` alerts (M2 slice 3), which are also not counted towards the cap.
- Drain: `claimOutboxRows` takes unsent rows with `attempts < 5` and an expired lease (`FOR UPDATE SKIP LOCKED`, lease 2 minutes, `attempts + 1`); a send error records `last_error` and releases the lease; a 4xx other than 408/429 (or an unreadable destination) sets `attempts = 5`. When every `alert` row of an alert is sent the alert is `sent`; when any is unsent at 5 attempts it is `failed`. An alert with no rows (raised before this deploy, or a deferred enqueue) is enqueued by the `alert-created` function first. The sweep finds tenants through `listPendingOutboxTenants` → `list_outbox_tenants(max_attempts, page_limit)` (migration 0018; SECURITY DEFINER, returns tenant ids only, EXECUTE revoked from PUBLIC and granted to `app_user`), then drains each tenant in its own tenant context.
- New alert kinds (M1): `install_during_session`, `payment_under_pressure`, `protection_disabled`. `protection_disabled` is server-generated (uninstall beacon, offline sweep) and rejected from clients.
- eve channel auth (M1, slice 3): `apps/web/agent/lib/app-session.ts` resolves the caller in-process with `resolveRequestSession(headers, "full")` (`apps/web/lib/server/session-core.ts`, free of `next/*`; `getSession()` runs the same core with Auth.js `auth()` as its cookie reader). Order: `Authorization: Bearer neo_dt_…` (hashed lookup; scope `full` only, a `signals:write`/`device` token is rejected) → `DEV_AUTH_BYPASS` (ignored when `NODE_ENV=production` or `VERCEL_ENV` is `production`/`preview`) → the `authjs.session-token` / `__Secure-authjs.session-token` cookie looked up in `sessions` (database strategy; expiry checked; household resolved as the Auth.js session callback does). No database means no cookie session. The whole walk is closed (no caller, 401) unless `NEO_EVE_CHAT=true`; `localDev()` after it still admits a local dev server only. Caller: `principalType "user"`, `principalId` = user id, `attributes: { tenantId, role: "owner" | "member" }`. Any error resolves to no caller (401). `/api/eve-session` and `NEO_APP_ORIGIN` are removed.
- eve session ownership (M1, slice 3): eve has no per-session access list, so `eve_sessions` (`session_id` PK, `tenant_id` fk cascade, `user_id` fk cascade, `created_at`; tenant RLS `tenant_isolation`, in `tenantTables`; migration **0019**) records the creator of every session. The channel's `events["session.started"]` writes it from the session initiator (`recordEveSession`, first record wins; `getEveSessionOwner(db, tenantId, sessionId)` is tenant-scoped, so another household's row is invisible). Route auth: any request whose path names a session (`/eve/v1/session/:id`, `/:id/stream`, `/cancel`, `/clear`, `/compact`, `/end`) is allowed only when the recorded owner is the caller's tenant and user; a session recorded for someone else is denied at once, an unknown id after waiting up to 3 s for the record of a just-created session. Create (`POST /eve/v1/session`) and the public health route need no id. A message-free (prewarmed) create is recorded only when its first message starts the session, so the chat always creates with a message. Without a database the map is in-process.
- eve read-only tools (`apps/web/agent/tools/`, M1 slice 3): `analyze_url { url }`, `analyze_email { text, from?, subject? }`, `analyze_sms { body, sender? }`, `get_incident { incidentId }` (kind, severity, status, title, body, created/acknowledged/resolved times, member display name, device name, `signals` minimized to `detector, subject, severity, observedAt`), `list_incidents { status?: "open" | "all", limit? ≤ 20 }`, `device_timeline { memberId? | deviceId?, hours? ≤ 24 }` (minimized: `detector, subject, severity, outcome, observedAt, device`), `list_members {}` (`id, displayName, role, mode, deviceCount`; no contact data). Optional inputs treat blank strings, `null` and `0` as absent. Tenant, user and role come only from the verified caller (`requireTenantCaller`); data goes through `tenantScoped()` (`apps/web/lib/server/incident-data.ts`); an owner sees the household, a member only what is about them; a foreign, unknown or malformed id returns `{ error: "not_found" }`. Every result reaches the model only as `wrapToolResult(name, output)` via `toModelOutput`. The incident tools need `DATABASE_URL` (the agent is a separate process from Next, so the in-memory MOCK_MODE stores are empty there). No acting tools in slice 3 (slice 4 adds `mark_expected` and `allow_once`).
- Incident chat (M1, slice 3): `/chat-v2` is gated by `NEO_EVE_CHAT` (exactly `true`; unset or anything else is a 404 before any sign-in redirect) and needs a browser session. `/chat-v2?incident=<uuid>` requires an alert in the caller's household (a member: about them) or 404s. The page sends the first message with `clientContext: { incidentId }`; the channel's `onMessage` re-checks the incident for the caller, drops all client context and replaces it with a server-written pointer ("Call `get_incident` with exactly that id"); no alert text is put in the prompt. The chat reports its eve session id to `POST /api/chat-v2/incident-session { incidentId, sessionId }` (browser session; 204, 404 for an alert the caller cannot see, 400 for a bad id) which stores it with `setAlertEveSession` only if the caller created that session (`eve_sessions`; else 404); reopening the alert resumes that session only when its creator is the current user (otherwise a new session starts and, once linked, overwrites) (`useEveAgent` `initialSession` + `resume`), and a failed resume offers a new conversation that overwrites it. With `NEO_EVE_CHAT=true` the alert email link (`alertLink`) and the dashboard alert item link to `/chat-v2?incident=<id>` ("Ask Neo about this") for every kind except `breach_detected`, `member_joined` and `member_left`.
- `@neo/db`: `recordEveSession(db, { tenantId, userId, sessionId })`, `getEveSessionOwner(db, tenantId, sessionId) → userId | undefined`, `isEveSessionId`; `setAlertEveSession(db, tenantId, id, eveSessionId) → boolean` stores `alerts.eve_session_id` (tenant-scoped; false for a malformed id or another household's alert).
- `POST /api/devices/heartbeat` request adds optional `policyVersion` (applied: hex, at most 64 characters, blank is absent, otherwise 400 `invalid`; stored lowercase as `devices.policy_version_applied`), and the response adds `policyVersion: string | null` (current, compiled without signing; null if it could not be computed) (M2 slice 2, migration 0022). Older clients are unaffected.
- `GET /api/devices/policy` (scope `device` + `deviceId`; the device and its member come from the token; 120/hour per device (429); 404 for a revoked device; 503 `policy_signing_unavailable` when no signer is configured) → `PolicyEnvelope = { bundle: PolicyBundle, sig, keyId, alg: "ES256" }` (M2 slice 2). `sig` is base64url (no padding) of the raw 64-byte ECDSA `r || s`, over the UTF-8 bytes of `canonicalJson(bundle)`; `bundle` is `{ v: 1, deviceId, memberId, policyVersion, issuedAt, expiresAt (+7 days), timeZone, mode, web: { categories, safeSearch, youtubeRestricted, allow, block, allowOnce?: [{ domain, until }] }, apps: { block, requireApproval, approved }, screenTime: { dailyMinutes: { mon..sun: number | null }, downtime, warnMinutes, allowDuringDowntime, grants: [{ minutes, until }] } }`, every section present for every mode (empty for Standard and Elder); `web.allowOnce` is present only when a Child device has a running one-hour allow (absent, not `[]`, otherwise, so the version of a bundle without grants is unchanged), and `screenTime.grants` / `web.allowOnce` are sorted by `until`. `web.allow` and `web.allowOnce` override categories and the `block` list. `policyVersion` = hex SHA-256 of the canonical bundle without `issuedAt`, `expiresAt` and `policyVersion`. `ETag: "<policyVersion>"`, 304 on match (a client within a day of its bundle's `expiresAt` omits `If-None-Match`), `Cache-Control: private, no-cache`. Clients embed `NEO_POLICY_PUBKEYS` (a JSON array of P-256 JWKs, each with `kid`).
- Category lists (M2 slice 4, spec `_specs/v2-m2-child.md` section 5). `GET /api/signals/lists` gains `categoryLists: { version, baseUrl, categories: { <category>: { file, sha256, count } } }` for the categories `adult|gambling|weapons|self_harm|drugs|proxy_vpn|social|games|streaming|dating`. `baseUrl` is an absolute URL of a directory with a trailing slash (the request's own origin plus `/category-lists/<version>/`, static files in `apps/web/public/`, served `public, max-age=31536000, immutable`); `<baseUrl><file>` is a sorted array of uint32, 4 bytes each **little-endian**, of `SHA-256(domain)[0..4]` read **big-endian**; `sha256` is of the file's bytes and `count * 4` its length. `version` (the response field, the `ETag` and the heartbeat `listsVersion`) becomes `<detection-lists hash>-<categoryLists.version>` when the server has category data, so existing clients refetch. The `ut1-*` files are CC BY-SA 4.0 and ship with `LICENSE-UT1.txt` next to them. Built by `scripts/category-lists/` (`fetch.mjs` then `build.mjs`; output committed; `apps/web/lib/data/category-lists.json` is the pointer the route imports). `@neo/tools` exports the type `CategoryListsInfo` and `DetectionListsPayload.categoryLists?`.
- `GET /api/devices/policy/keys` (no authentication; `Cache-Control: public, max-age=3600`; 503 `policy_signing_unavailable`) → `{ keys: [{ kid, alg: "ES256", jwk }] }`. For docs and rotation tooling only; clients never verify against it.
- `@neo/verdict`: `canonicalJson(value)`, `PolicyBundleSchema`, `PolicyEnvelopeSchema`, `policyVersionBody(bundle)`, `verifyPolicyEnvelope(envelope, keys) → { ok: true, bundle } | { ok: false, reason: "malformed" | "unknown_key" | "bad_signature" }` (WebCrypto only; expiry is not checked), `base64urlEncode/Decode`. `@neo/core`: `compileBundle({ device, member, layers, birthYear, timeZone, now, grants, allowOnce? }) → PolicyBundle` (pure; `grants` and `allowOnce` are only used for a Child device), `computePolicyVersion`, `endOfLocalDay(now, timeZone | null) → Date` (the first instant of the next local day; UTC for null or an unknown zone).
- `@neo/db`: `policy_bundles` (`device_id` PK → devices cascade, `tenant_id`, `policy_version`, `bundle` jsonb, `sig`, `key_id`, `issued_at`, `expires_at`; tenant RLS; in `tenantTables`), `getPolicyBundle(db, tenantId, deviceId)`, `upsertPolicyBundle(db, tenantId, row)`; `devices.policy_version_applied` (also on `DevicePublic`); `recordHeartbeat({ policyVersion? })`. Migration **0022_policy_bundles**.
- Env (all optional; see `.env.example`): `NEO_POLICY_KMS_ISSUER` (Vercel KMS issuer id, wins), `NEO_POLICY_SIGNING_KEY` (PKCS8 PEM, P-256), `NEO_POLICY_KEY_ID`. None set: an ephemeral key outside production/preview; 503 on `GET /api/devices/policy` on production/preview.
- Console: `DeviceItem.policy?: "current" | "pending" | "update_needed" | "unknown"` on the devices in `GET /api/household` (not on heartbeat or enroll responses); `MemberDetailResponse.devices?: [{ id, name, kind, platform, status, lastSeenAt, policy: "current" | "pending" | "update_needed" | "unknown" }]` on `GET|PATCH /api/household/protected-members/[id]`.
- Child requests (M2 slice 3; migration **0024_child_request_tokens**; spec `_specs/v2-m2-child.md` §8 and "Slice 3: what was built"). Postgres only (503 `storage_unavailable` without a database).
  - `POST /api/devices/requests` (scope `device`; the member is the device's; strict body, so an unknown field such as `memberId` is 400) `{ kind: "more_time" | "unblock_site" | "install_app", detail, reason? }` → **201** `{ id, status: "pending", expiresAt }`, or **200** with the existing request when an identical one (same device, kind, detail) is pending. `detail`: `more_time { minutes: 5..120 }`; `unblock_site { domain }` (trimmed and lowercased, a lowercase registrable-looking domain); `install_app { app: AppRef }`. `reason`: at most 140 characters (400 over, not truncated), control/line-separator/bidi characters become spaces, blank is none; it is attacker-controlled text. Errors: 400 `invalid` (with `fields`), 404 (revoked device), 409 `not_child_mode`, 429 `too_many_pending` (5 pending per device; an expired-but-unswept request and the engine's `origin = 'engine'` requests do not count), 429 `daily_limit` (20 per device per UTC day, decided ones included, engine-opened ones not), 503. `expiresAt` = the end of the child's day in the household zone (UTC when unset).
  - `GET /api/devices/requests/:id` → `{ id, kind, status, detail, createdAt, expiresAt, decidedAt, grant }` for the device's **own** request (404 for anything else; a past-expiry pending request reads `expired`); `GET /api/devices/requests?status=pending` → `{ requests: [...] }` (this device's, newest first; only `pending` is accepted as a filter). 300 reads per device per hour.
  - Notification: each new request raises an alert of kind `child_request` (medium; dedupe `child_request:<requestId>`; text from `childRequestAlertText`, never the reason) linked through `child_requests.alert_id`. Recipients (`resolveRequestRecipients`, pure): `notify.childRequestsTo` `owners` (every owner with an address, **regardless of `alert_email_threshold`**) or `helpers` (the helpers with an address, else the owners); never the child. `child_request` and `app_approval` alerts are exempt from the 20-a-day email cap and are not counted by it (`REQUEST_ALERT_KINDS`, `isRequestAlertKind`). The email (`renderChildRequestEmail`) names the member and the ask, quotes the reason apart from Neo's text (escaped; "Neo does not act on it"), and for an owner with an account has **Approve** and **Deny** links to `/requests/<id>/decide?t=<token>&a=approve|deny` (and "Ask Neo about this" with `NEO_EVE_CHAT`).
  - Token: 32 random bytes (base64url) per request, stored as `decision_token_hash` (SHA-256 hex) with `decision_token_expires_at` (24 h), cleared when the request is decided (single use). The raw token reaches the email only inside the outbox row's payload, sealed (`sealDecisionToken` / `openDecisionToken`, the contact envelope with its own key label and AAD bound to the row key). The token never decides anything: the page and the decision need a signed-in owner and a confirm.
  - Engine: an `app_approval` incident also opens one `install_app` request (`{ app }` from the signal's `bundleId`, else `signer` and `image`; none of them means no request), linked to the app_approval alert (`openInstallAppRequest`, no rate limits, deduped on a pending request for the same device and app, which also means no second alert or email).
  - `GET /requests/[id]/decide?t=&a=` (page): `requireSession` (signed-out go to sign-in and back), `requireHouseholdAdmin`, tenant-scoped load (another household's id is 404). States: ready, forbidden (not an owner), decided (including a used link), expired, token invalid, token expired. It never decides. `Referrer-Policy: no-referrer` for `/requests/*`.
  - `POST /api/household/requests/[id]/decision` `{ decision: "approve" | "deny", minutes?, scope?: "once" | "always", token? }` (browser session + `requireHouseholdAdmin`) → `{ request, message }`; 400 `invalid`, 403 `not_allowed` | `token_invalid`, 404 `not_found`, 409 `already_decided` | `policy_limit`, 410 `expired` | `token_expired`. `GET /api/household/requests?memberId=&status=` → `{ requests: ChildRequestItem[] }` (owners; pending first; at most 50).
  - `decideChildRequest(actor, requestId, decision, { minutes?, scope?, token?, via: "link" | "console" | "agent" })` (`apps/web/lib/server/child-requests.ts`, no `next/*` imports): owner check (DB), tenant-scoped load, pending and unexpired, token (if given), exact effect, policy-limit check, then one atomic claim (`decideChildRequestRow`, `WHERE status = 'pending'`; the claim is undone by `revertChildRequestDecision` if the policy write fails), the alert resolved, an `incident_actions` row (`approve_request` / `deny_request`; `requested_by` `agent` for `via: "agent"`, else `admin`) and the audit event `child_request.decided` `{ requestId, memberId, kind, decision, via, minutes?, scope? }` (no reason). Effects: `more_time` stores `grant { minutes (1..120, the owner's figure or the asked one), until (end of the household's day) }`; `unblock_site` once `grant { domain, scope: "once", until: now + 1 h }`, always `{ domain, scope: "always" }` and the domain is appended to the member's `web.allow` (a new member policy version via `updateMemberRules`; deduped; refused at 200 domains); `install_app` appends the `AppRef` to `apps.approved` (100); deny stores no grant. Running grants (`activeChildGrants`) become the bundle's `screenTime.grants` and `web.allowOnce`.
  - eve tools: `list_requests {}` (owners only; pending; `{ id, member, device, kind, asks, childsReason, createdAt, expiresAt }`), `approve_request` and `deny_request` `{ requestId, minutes?, scope? }` (strict; blank, null and 0 are absent; `approval: { request: always(), prompt }`; the prompt is built from the validated input only, since eve prompts are synchronous with no session; `execute` loads the stored request and reports the exact effect). Results: `{ ok: true, action, requestId, status, message }` or `{ ok: false, error: "not_found" | "not_allowed" | "already_decided" | "expired" | "invalid" | "policy_limit" | "failed", message }`, all through `wrapToolResult`.
  - Retention: the daily `artifacts-expire` job runs `expire_child_requests(now)` (security definer, `EXECUTE` for `app_user` only): pending requests past `expires_at` become `expired` (token cleared) and their open alerts `resolved`.
  - `@neo/db`: `createChildRequest` (serialized per device; dedupe, 5/20 limits, `source: "system"` skips the limits), `getChildRequest`, `getChildRequestByAlert`, `listChildRequests`, `setChildRequestAlert`, `decideChildRequestRow`, `revertChildRequestDecision`, `markChildRequestExpired`, `activeChildGrants`, `summarizeChildRequests`, `expireChildRequests`, `updateMemberRules`; `incident_actions` kinds `approve_request`, `deny_request`. The weekly digest has a `childRequests` slot (owners only; counts by kind and outcome).
- Member-only devices (M2): `devices.user_id`, `device_enrollment_codes.user_id`, `device_signals.user_id` and `desktop_tokens.user_id` (monitoring tokens) become nullable, with `member_id` as the key. A device session for an account-less member is `{ tenantId, memberId, deviceId, userId: null, role: null }`. Correlation dedupe keys stay `<kind>:<userId>:<bucket>` for members with an account; account-less members use `<kind>:m:<memberId>:<bucket>`.
- `member_id` is always resolved server-side from the device; clients never send it.
- Migration `0020_member_devices` (M2 slice 1a), `@neo/db` signatures: `devices.user_id`, `device_enrollment_codes.user_id`, `device_signals.user_id` and `desktop_tokens.user_id`/`role` are nullable; `device_signals.member_id` is NOT NULL (FK cascade); `devices.member_id` and `device_enrollment_codes.member_id` are set on every active device and pending code by CHECK (`devices_member_check`: `member_id IS NOT NULL OR revoked_at IS NOT NULL`; codes also allow `redeemed_at`), because removing a person deletes their `members` row while their devices stay as revoked rows (FK `ON DELETE SET NULL`); `desktop_tokens_subject_check` makes a `full` token need `user_id` and `role` and a monitoring token need `device_id` and (until revoked) `member_id`; `tenants.time_zone text null` (`getHouseholdTimeZone`, `setHouseholdTimeZone(db, tenantId, tz | null)` validated by `normalizeTimeZone`, throws on a non-IANA name). Rollout triggers fill `member_id` for writers that omit it. `DevicePublic`/`EnrollmentCodePublic` gain `memberId` and `userId: string | null`; `createEnrollmentCode(db, { tenantId, createdBy, now?, userId | memberId })`; `listDevices(db, tenantId, { userId?, memberId? })`; `insertDeviceSignal` takes `memberId?` (the device's member when omitted) and `userId: string | null`; `listRecentMemberSignals(db, tenantId, memberId, opts)` (`listRecentUserSignals` finds an account holder's member); `getProtectionLayers(tdb, { userId | memberId, deviceId? })`; `listAlerts`/`countOpenAlerts` take `memberId` and `aboutUserId` (the member behind an account) beside `subjectUserId`; `ResolvedDesktopToken` gains `memberId` and has nullable `userId`/`role`; `insertDeviceToken` takes `memberId` and nullable `userId`/`role`; `revokeMemberDevicesTx(tx, tenantId, memberId, now)`, and `deleteMemberForUserTx` revokes the member's live devices, codes and tokens before deleting the row. Verdicts need a user (`verdicts.user_id`), so a signal alert for a member without an account is raised without a verdict.
- New `SIGNAL_DETECTORS`: `payment_page` (M1, server first; the extension sends it from M2); `web_blocked`, `app_installed`, `app_blocked`, `screen_time_exhausted`, `tamper_detected` (reasons `browser_without_extension|vpn_app|extension_disabled|clock_changed|agent_service_stopped|bad_policy_signature`) (M2). New alert kinds (M2): `self_harm_attempts`, `app_approval`, `child_request`. Clients ship after the server (older servers reject unknown detectors as `invalid`).
- `requireHouseholdAdmin(actor: { tenantId, userId, role? }) → { ok: true } | { ok: false, status: 403, code: "forbidden", message }` (`apps/web/lib/server/household-admin.ts`, M1 slice 4; no `next/*` imports). The v2 owner check: it ignores the role the caller carries (session cache, eve caller attribute) and re-reads `memberships.role` from the database (`getMembershipRole`), so a demoted or removed owner is refused at once. A storage error propagates (routes answer 503, the tools return `failed`). Without a database it reads the in-memory household; a household with no memory members falls back to the claimed role (MOCK_MODE only). Used by every new route and both acting tools; existing routes keep their inline `role !== "owner"` checks until they are touched.
- Member console routes (M1 slice 4; browser session via `requireBrowserApiSession` + `requireHouseholdAdmin`; tenant-scoped; JSON; errors `{ error, code }` as the other household routes; the id is a `members` row id). They live under `/api/household/protected-members/[id]` because `/api/household/members/[userId]` already exists with a user-id slug and Next.js allows one slug name per level. Blank strings and `null` mean "no change" (except `contact: null`, which clears the helper address, and `helpersNotifyAt/ownersNotifyAt: null`, which removes the member's own setting).
  - `GET /api/household/protected-members/[id]` and `PATCH` (`{ displayName?, role?, mode?, helperMemberIds?, contact? }`) → `{ member: { id, displayName, role, mode, hasAccount, helperMemberIds, hasContact }, contactHint, others: [{ id, displayName, hasAccount }], notify: { helpersNotifyAt, ownersNotifyAt }, policySummary: string[], isLastOwner }`. Rules: role `owner` is never given or taken away (409 `owner_role`); mode `child` needs a birth year and the household time zone (see "Child policy" below); the only owner cannot leave Standard mode (409 `last_owner`); helpers are at most 10 other members of this household (400 `invalid_helper`, including self); `contact` is accepted only for a member without an account (400 `has_account`), must be one email address (400 `invalid_email`) and is stored encrypted (members.ts envelope), never returned (only a masked hint), never audited. 403 `forbidden` (not an owner now), 404 `not_found` (unknown id, another household's id), 400 `invalid` (bad body, unknown keys).
  - `PUT /api/household/protected-members/[id]/policy` (`{ helpersNotifyAt?, ownersNotifyAt? }`, each `low|medium|high|critical`) appends the next `member`-scope `policies` version: the member's current member-layer rules with `notify` merged over them, validated by `PolicyRulesSchema`; nothing is written when nothing changes. Same body as GET.
  - Turning Elder mode off sends every owner the templated email `renderElderModeOffEmail` (not model text) through the mailer, with Resend idempotency key `elder-off:<memberId>:<the member row's previous updated_at ms>:<ownerUserId>`: a double submit shares the key (and a repeat finds Standard already and sends nothing). Turning it on sends no email.
  - Audit (`audit_events`, no contact values): `member.updated` `{ memberId, fields: ("displayName"|"role"|"contact"|"birthYear")[] }`, `member.mode_changed` `{ memberId, from, to }`, `member.helpers_changed` `{ memberId, count, added, removed }`, `member.policy_changed` `{ memberId, version, helpersNotifyAt?, ownersNotifyAt? }`.
- Child policy (M2 slice 1b; migration **0021_child_policy**, spec `_specs/v2-m2-child.md` §3 and "Slice 1b: what was built"):
  - `@neo/verdict` policy sections (all fields optional; no defaults):
    ```ts
    web:        { categories?: Category[]; safeSearch?: boolean; youtubeRestricted?: "off" | "moderate" | "strict"; allow?: string[]; block?: string[] }
    apps:       { block?: AppRef[]; requireApproval?: boolean; approved?: AppRef[] }
    screenTime: { dailyMinutes?: { mon..sun?: number | null }; downtime?: { start: "HH:MM"; end: "HH:MM" }[]; warnMinutes?: number; allowDuringDowntime?: AppRef[] }
    notify.childRequestsTo?: "owners" | "helpers"   // default owners
    type Category = "adult" | "gambling" | "weapons" | "self_harm" | "drugs" | "proxy_vpn" | "social" | "games" | "streaming" | "dating"   // WEB_CATEGORIES
    type AppRef = { bundleId: string } | { signer?: string; image?: string }   // at least one of signer/image; image is a file name, not a path; bundleId reverse-DNS
    ```
    Limits: domains lowercase, at least two labels, last label alphabetic, 3 to 253 chars, at most 200 each in `allow` and `block`; at most 100 `AppRef`s per list; `dailyMinutes` 0 to 1440 or `null` (no limit); `HH:MM` 24-hour; at most 6 downtime windows (a window can cross midnight); `warnMinutes` 0 to 120; categories unique. Exports: `WEB_CATEGORIES`, `YOUTUBE_LEVELS`, `CHILD_REQUEST_TARGETS`, `WEEKDAYS`, `WebRulesSchema`, `AppsRulesSchema`, `ScreenTimeRulesSchema`, `AppRefSchema`, `MAX_POLICY_DOMAINS`, `MAX_POLICY_APP_REFS`, `MAX_DOWNTIME_WINDOWS`. The old `screen_time` placeholder key is removed (stripped from stored rows).
  - `@neo/core`: `AgeBand = "under_10" | "10_13" | "14_17"`; `ageBand(birthYear | null | undefined, now, timeZone?) → AgeBand` and `ageBandInfo(...) → { band, age: number | null, assumed: boolean, adult: boolean }` (`age = year(now in timeZone, UTC when null) - birthYear`; no birth year → `10_13` and `assumed`; 18 or more → `14_17` and `adult`); `childDefaults(band = "10_13") → PolicyRules` (the spec §3 table, plus Elder's `remote_access`, `devices.protectionDisabledSeverity: high` and `notify { helpersNotifyAt: high, ownersNotifyAt: high, childRequestsTo: owners }`); `DEFAULT_AGE_BAND`, `AGE_BANDS`.
  - Client detectors (`SIGNAL_DETECTORS`; server first, no client sends them yet; every variant `.strict()`, `type` in parentheses):
    - `web_blocked` (`page`) `{ domain, category: Category }`: `domain` re-checked as a registrable domain like the other page detectors; never a URL.
    - `app_installed`, `app_blocked` (`software`) `{ name, signer?, image?, bundleId? }`: names only, never paths.
    - `screen_time_exhausted` (`usage`) `{}`.
    - `tamper_detected` (`tamper`) `{ reason: "browser_without_extension" | "vpn_app" | "extension_disabled" | "clock_changed" | "agent_service_stopped" | "bad_policy_signature" }` (`TAMPER_REASONS`).
    - `SIGNAL_TYPES` adds `usage` and `tamper`. `device_signals.subject`: the domain, the app name, `screen_time`, or the tamper reason.
  - Decisions (`evaluateSignal`; Standard and Elder decisions for every earlier detector are unchanged):
    - `web_blocked`: record, except 3 or more `self_harm` blocks within 60 minutes across the member's devices (edges inclusive), which is an incident `self_harm_attempts`, high, when the policy has a `web` section.
    - `app_installed`: incident `app_approval`, medium, `notifyNow` always, when `apps.requireApproval`; else record.
    - `app_blocked`, `screen_time_exhausted`: record.
    - `tamper_detected`: incident `protection_disabled` (reason codes `["tamper_detected", reason]`) with severity `devices.protectionDisabledSeverity` (Child and Elder defaults: high); record when unset (Standard).
    - Dedupe keys: `self_harm_attempts:<subjectKey>:<UTC hour>` (`subjectKey` = user id, else `m:<memberId>`); the others `<kind>:<deviceId>:<detector>:<subject>:<UTC hour>`.
  - Alert kinds `self_harm_attempts`, `app_approval`, `child_request` (`ALERT_KINDS`, `alerts_kind_check`); templates in `apps/web/lib/server/alerts/templates.ts` (`selfHarmAttemptsAlertText`, `appApprovalAlertText`, `childRequestAlertText`, and `protectionDisabledAlertText` with a plain sentence for each tamper reason). Nothing raises `child_request` or creates a `child_requests` row until slice 3.
  - `@neo/db`: `consents` (`id`, `tenant_id`, `member_id` fk cascade, `kind` `monitoring_notice | guardian_consent | elder_self_consent`, `granted_by` fk users set null, `granted_at`, `evidence` jsonb; tenant RLS; index `(tenant_id, member_id, granted_at desc)`) with `recordConsent(tdb, { memberId, kind, grantedBy, evidence? })` (throws for a member outside the household) and `listConsents(tdb, memberId)`; `child_requests` (`tenant_id`, `member_id` fk cascade, `device_id` fk set null, `kind` `more_time | unblock_site | install_app`, `detail` jsonb, `reason` ≤ 140 chars, `status` `pending | approved | denied | expired` default `pending`, `decided_by` fk users set null, `decided_at`, `grant` jsonb, `alert_id` fk alerts set null, `created_at`, `updated_at`, `expires_at`; tenant RLS; index `(tenant_id, status, created_at)`); both in `tenantTables`. `createMemberWithoutAccount(tdb, { displayName, role: "adult" | "child" | "elder", birthYear?, contact? }) → Member` (contact encrypted; at most `MAX_MEMBERS_WITHOUT_ACCOUNT` = 20 per household). `getProtectionLayers` also returns `birthYear` (Child mode, when set) and `timeZone` (Child mode, when set).
  - Console routes (browser session + `requireHouseholdAdmin`; errors `{ error, code, fields? }` where `fields` is `[{ path, message }]` for validation errors):
    - `POST /api/household/protected-members` `{ displayName, role: "adult" | "child" | "elder", birthYear?, contact? }` → 201 member detail. Standard mode, no account. A child needs `birthYear` (400 `birth_year_required`); `contact` only for an adult or elder (400 `contact_not_allowed`, `invalid_email`); 400 `invalid`, `invalid_name`, `invalid_birth_year`; 409 `member_limit`. Audit `member.created` `{ memberId, role, hasBirthYear, hasContact }`.
    - `PUT /api/household/time-zone` `{ timeZone }` → `{ timeZone }` (the canonical IANA name; 400 `invalid`, `invalid_time_zone`). Audit `household.time_zone_changed` `{ from, to }`.
    - `PATCH /api/household/protected-members/[id]` also takes `birthYear` (`null` clears; 400 `invalid_birth_year`). `mode: "child"` needs a birth year, stored or in the same request (400 `birth_year_required`), and a household time zone (400 `time_zone_required`); it records a `consents` row (`monitoring_notice`, granted by the owner, evidence `{ mode: "child", band }`) and audits `member.consent_recorded` `{ memberId, kind }`. Turning Child off (to Standard or Elder) emails every owner (`renderChildModeOffEmail`, Resend key `child-off:<memberId>:<previous updated_at ms>:<ownerUserId>`).
    - `PUT .../policy` also takes `childRequestsTo` and the sections `web`, `apps`, `screenTime`: an object replaces the member's own copy of that section, `null` removes it (the age band's defaults apply again); unknown keys, bad domains, times, limits are 400 `invalid_policy` with `fields`. Audit `member.policy_changed` `{ memberId, version, <changed key>: value | "set" | null }`.
    - Member detail (`GET`, `PATCH`, `PUT .../policy`, `POST`) adds `member.birthYear` and `child: { birthYear, band, bandAssumed, adult, timeZone, defaults, settings, customized }` (`defaults` = the band's settings, `settings` = in force, both with every field filled).
- eve acting tools (`apps/web/agent/tools/`, M1 slice 4), both `approval: { request: always(), prompt }` (eve's default response policy: only the requesting user answers; the call runs as them, and `incident_actions.approved_by` is their user id). Input is the incident id only (`mark_expected { incidentId }`, `allow_once { incidentId, note? ≤ 200 }`, strict, blank note = absent): no tool id, peer id or tenant. At execution (`performIncidentAction`, `apps/web/lib/server/incident-actions.ts`): `requireTenantCaller` → `requireHouseholdAdmin` against the database → load the alert tenant-scoped → refuse a closed one. Results are `{ ok: true, action, incidentId, status, message }` or `{ ok: false, error: "not_found" | "not_allowed" | "already_closed" | "not_remote_access" | "failed", message? }` through `wrapToolResult`; success is only reported after the change is stored.
  - `mark_expected`: only an alert of kind `remote_access` with a device; the tool id and remote ID come from the alert's own `signal_ids` (`device_signals.payload.toolId`, `.peerId`, newest `remote_access_session` first) on the alert's device. `addDeviceExpectedTool` merges them into `device_expected_tools` (≤ 10 tools, ≤ 10 peers, peer `^[A-Za-z0-9 _.@-]{1,64}$`, known catalog tool; a violation is a refusal that changes nothing) and audits `device.expected_tools_changed`; then `resolveAlert(..., "false_positive")`.
  - `allow_once`: `resolveAlert(..., "resolved")`; no policy change; the optional note goes into `incident_actions.result`, not the audit.
  - Both write an `incident_actions` row (`requested_by: "agent"`, `approved_by`, `status` `done`/`failed`, `result`) and audit `incident.action` `{ alertId, kind, status }`.
- `@neo/db` (slice 4): `resolveAlert(db, tenantId, id, "resolved" | "false_positive", userId, now?) → AlertRow | undefined` (atomic on status `open|acknowledged`; sets `resolved_at` and, when nobody has, `acknowledged_at/by`, so a closed incident leaves the open counts); `recordIncidentAction(db, tenantId, input)` (throws unless the alert is in the household) and `listIncidentActions`; `latestMemberRules(tdb, memberId)`, `getMembershipRole(tdb, userId)`, `countHouseholdOwners(tdb)`.
- Alerts API: `AlertItem` gains `status` (`open|acknowledged|resolved|false_positive`); the dashboard panel labels `resolved` ("Resolved") and `false_positive` ("False alarm"). `/chat-v2` renders the agent's approval requests (`openInteractions`, `respond([{ interactionId, optionId }])`) with Approve / Deny buttons and the outcome of an acting tool call.
- eve tools: tenant from the verified caller only (the same identity `getSession()` resolves), DB through `tenantScoped()`, results through `wrapToolResult`, acting tools `always()` approval with a server-side admin check.

## M3 slice 1: eve schedules beside Inngest ( spec `_specs/v2-m3-cutover.md`)

- `schedule_runs` (`@neo/db`, migration **0025_schedule_runs**, journal `when` `1793633046799`): `id` uuid PK, `job` text, `runner` `inngest|eve`, `mode` `shadow|live`, `started_at`, `finished_at`, `outcome` `ok|error`, `summary` jsonb (`{ counts: Record<string, number>, digest: string, actions: number }`: counts and a SHA-256 hex digest of the planned actions, never an address, email or message content), `error` text (a short message, at most 300 characters). **Not tenant data**: no `tenant_id`, no RLS, like `reputation_cache`; `app_user` gets `SELECT, INSERT, DELETE` (rows older than 90 days are pruned by the retention job). Index `(job, started_at desc)`.
- `NEO_EVE_SCHEDULES`: comma-separated job names from `weekly-digest`, `devices-offline`, `breach-monitoring`, `retention`, `outbox-sweep`. Default empty. A listed job runs **live in eve and is a no-op in Inngest**; every other job runs **live in Inngest and shadow in eve**. Names are trimmed and matched exactly; unknown names are ignored with a warning. Unset means no behaviour change.
- Eve schedules (`apps/web/agent/schedules/<job>.ts`): `defineSchedule({ cron, run })`, UTC, no prompt and no model session (the handler never calls `to(...).send`). Crons: `weekly-digest` `0 14 * * 1`, `devices-offline` `0 * * * *`, `breach-monitoring` `0 15 * * 1`, `retention` `0 4 * * *`, `outbox-sweep` `*/5 * * * *` (the same as the Inngest functions).
- Job core (`apps/web/lib/server/schedules/`): `type PlannedAction = { tenantId: string | null; kind: string; key: string }`; `plannedActionsDigest(actions) → string` (sorted `tenantId|kind|key` lines, SHA-256 hex); `type JobDeps<Read, Effects> = { mode: "shadow"; read: Read } | { mode: "live"; read: Read; effects: Effects }` (shadow has no effects at all: read ports plus a recorder); `scheduleRoute(job, runner, env?) → "live" | "shadow" | "skip"`; `recordScheduleRun(...)` never throws (a missing table or database only logs).
- `@neo/db`: `insertScheduleRun(db, input)`, `listScheduleRuns(db, job, since)`, `pruneScheduleRuns(db, olderThanDays, now?)`. apps/web: `compareScheduleRuns(job, since) → { job, since, pairs: [{ inngest, eve, digestsMatch }], unpaired }` (read-only; pairs each eve run with the nearest Inngest run of the same job within half the job's cadence, at most 10 minutes; advisory: a shadow run and a live run read the same data a moment apart and the live one changes it, so a single differing digest on a state-changing job can be that race).
- Scope of the cutover in slice 1: `weekly-digest` and `breach-monitoring` move their **fan-out stage** (period and recipients, address discovery). Live eve sends the same Inngest events (same ids) through the Inngest client, and the event-triggered functions (`weekly-digest-send`, `breach-monitoring-check`, with HIBP rate limiting) stay on Inngest. `devices-offline`, `retention` (`artifacts-expire`) and `outbox-sweep` move whole. `breach-verification-cleanup` (daily token purge) and the Outlook crons stay on Inngest. Eve schedules become Vercel Cron Jobs, so `outbox-sweep` (every 5 minutes) and `devices-offline` (hourly) need a plan that allows them.

### eve chat parity (M3 slice 2, `_specs/v2-m3-cutover.md` section 2)

Everything below is behind `NEO_EVE_CHAT` (unset: off; `/chat-v2` 404, `/eve/v1/*` closed). The old chat and `/api/agent` are unchanged.

- **Verdict cards (2a, 2b, 2d).** The agent's instructions (`agent/instructions/checks.ts`, built at build time) carry the old chat's analyzer guidance and the same `verdict` fenced-block convention (`lib/verdict-fence.ts`, `verdictJsonSchema`). `/chat-v2` renders Neo's text with `components/MessageContent` (Markdown, `VerdictCard`, the hidden `<!-- playbook:<id> -->` marker), so the card is the old chat's component. The tool results themselves are analyzer output, not a `Verdict`, and have no card. Pasted text only: the channel sets `uploadPolicy: "disabled"` (no `.eml` or screenshot upload yet).
- **End of turn (`agent/lib/turn-settled.ts`, channel `events["turn.settled"]`).** For the person who spoke the turn (`ctx.session.auth.current` via `tenantCallerOf`; no household caller records nothing): (1) one `usage_events` row, `kind: "check"`, tokens summed over the turn's model calls (`runs(view, { turnId })`), `model` = the last call's model id, `tier` from the catalog, `conversationId` null (eve session ids are not conversation uuids); a turn with no model call and the canned cap refusal record nothing; (2) the last valid verdict block in the reply is stored with `saveChatVerdict` (`source: "chat"`) after the sign-in alert hook (`selectSigninAnalysis`, `finalizeSigninVerdict`, the ambiguous and hook-failure caps) using the turn's `analyze_email` outputs from the stream; a model-written `signin_check` is always dropped. The live card is not redrawn after a sign-in override (the old chat's `verdict_override` event has no eve equivalent): the stored verdict is the deterministic one. A `analyze_email` result stored by reference (too large to read inline) skips the sign-in rules (logged).
- **Playbooks (2c).** `get_playbook { id }` (read-only; `id` one of `PLAYBOOK_IDS`) returns `{ id, title, playbook }` from `lib/server/playbooks` (the markdown the old chat puts in its system prompt), through `wrapToolResult`. The playbook entry buttons on an empty `/chat-v2` send the old `playbookPrompt(id)`.
- **"Was this you?" (2e).** `pending_signin_alerts {}` (read-only) lists the caller's own alerts still being asked about: `signin_events` with a device not remembered, newest first, last 14 days, at most 5, each with a stored verdict that still carries a `signin_check` (`lib/server/signin/pending.ts`); entries are `{ verdictId, provider, event, device, location_advisory, event_time, received_at }`, wrapped. `confirm_signin { verdictId, wasMe }` is an acting tool, `approval: { request: always(), prompt }` (the prompt is fixed text; it quotes nothing from the alert). At execution (`lib/server/signin/chat-answer.ts`): `requireTenantCaller`, membership re-read from the database (`currentHouseholdRole`, else `not_allowed`), then `answerSigninCheck` (the card's rule: only the verdict's own member; an owner, another member and another household get `not_found`; no check on the verdict is `no_signin_check`). Result `{ ok: true, wasMe, message, playbook? }` (`playbook: "account_takeover"` for "not me") or `{ ok: false, error: "not_found" | "no_signin_check" | "not_allowed" | "failed", message }`; success writes audit `signin.answered` `{ verdictId, wasMe, via: "eve_chat" }`. The old route's rule is kept on purpose: an owner cannot answer for a member (sign-in details are the member's own, `_specs/signin-alerts.md`). `answerSigninCheck` and `getVisibleVerdict` now take `VerdictViewer = Pick<NeoSession, "tenantId" | "userId" | "role">`.
- **Model routing and caps (2f, `agent/lib/model-choice.ts`).** `agent.ts` is `defineDynamic(chooseModel)`. Per turn (memoized by turn id: later model calls of the same turn, such as after an approval, neither re-check nor re-route): the verified caller's household is checked with `checkCaps` (`agent/lib/usage-gate.ts`); over a cap, or the usage store failing (fail closed), the turn is answered by a canned model (`REFUSAL_MODEL_ID`, no provider call, zero tokens) with `capMessage` (the 429 sentence, now exported from `lib/server/usage.ts`) or "Neo can't check your usage right now."; a `usage.cap_hit` audit event is written as in the old chat. Otherwise the caller's `routing_preference` and `model_family` (`getMemberPreferences(tenantId, userId)` for exactly the caller's tenant and user) feed `routeTurn` (Jev or rules, `NEO_ROUTER`) and `selectionForRoute` returns the gateway slug, `gatewayProviderOptions` (ZDR, region, order, `models` fallbacks), `providerOptions.anthropic.{thinking,effort}` from `requestShape` for Anthropic models that take them, `reasoning` for other families that list efforts, and neither for Haiku 4.5. `MOCK_MODE` keeps a scripted model (all tools, verdict blocks) after the same cap gate. A local-dev caller with no household gets the medium rung, unmetered. eve always reaches models through AI Gateway; a non-Anthropic family still needs `NEO_MODEL_GATEWAY` and `AI_GATEWAY_API_KEY` to be chosen, as in the old chat.
- **Not built (gaps).** `.eml`/screenshot attachments, conversation history list and resume for non-incident chats, context compression (eve compaction replaces it), the NDJSON `route`/`usage` events, per-turn playbook pinning to Opus/high effort, the previous-verdict routing signal, live redraw of a sign-in override, owner answering for a member.

## M3 slice 5: Twilio SMS channel behind a flag, mock only (spec `_specs/v2-m3-cutover.md` section 5)

- `member_channels` (`@neo/db`, migration **0026_member_channels**, journal `when` `1793633106799`): `id`, `tenant_id` (cascade), `member_id` (cascade to `members`), `channel` (`sms`), `platform_id` (E.164), `verified_at` null, `verification_code_hash` null (HMAC-SHA-256 keyed from `NEO_MASTER_KEY` per household, bound to member and number), `verification_expires_at` null, `verification_attempts` (persisted), `created_at`. Unique `(channel, platform_id)` where verified; tenant RLS; in `tenantTables`. The same migration adds `sms` to the `notification_outbox.channel` CHECK (`OUTBOX_CHANNELS = ["email", "sms"]`; nothing enqueues an `sms` row and `claimOutboxRows` drains `email` only).
- `lookup_member_channel(channel text, platform_id text) → (tenant_id uuid, member_id uuid, user_id text, role text)` (SECURITY DEFINER, EXECUTE revoked from PUBLIC and granted to `app_user`): verified rows only, `role` is the household role from `memberships` (`member` when the member has no account).
- `@neo/db`: `normalizeE164`, `startChannelVerification(tdb, { memberId, channel, platformId }) → { ok, channel, code } | { ok: false, reason: no_member|limit|taken }` (3 numbers per member, 10 minutes), `confirmChannelVerification(tdb, { memberId, channel, platformId, code }) → { ok, channel } | { ok: false, reason: not_found|invalid|expired|too_many_attempts|taken }` (5 attempts, persisted; the code is cleared on success, expiry or exhaustion), `listMemberChannels`, `removeMemberChannel`, `lookupMemberChannel(db, channel, platformId) → { tenantId, memberId, userId, role } | undefined`.
- Console (owner, browser session, `requireHouseholdAdmin`; all 404 while `NEO_TWILIO_ENABLED` is not `true`): `GET|POST /api/household/protected-members/[id]/channels` (`POST { phone }` stores an unverified claim and sends the code through `SmsSender`), `POST .../channels/verify { phone, code }`, `DELETE .../channels/[channelId]`. Responses `{ channels: [{ id, channel, display, verified, verificationExpiresAt }] }` (`display` shows the last four digits only). Errors: 400 `invalid_number|invalid_code`, 404, 409 `channel_limit|number_unavailable`, 410 `code_expired`, 429 `too_many_attempts|rate_limited`. Rate limits (per instance, beside the persisted attempts): 5 codes per household per 10 minutes, 3 per number per hour, 15 confirms per member per 10 minutes. Audit: `member.channel_code_sent|channel_verified|channel_verify_failed|channel_removed` with `{ memberId, channel, phoneHash }`.
- apps/web `SmsSender { send({ to, body, purpose }) → { id } }` (`lib/server/sms-sender.ts`); `getSmsSender()` always returns the mock (logs a hash of the number, never calls the network). `mockTwilioFetch` is the `api.fetch` given to eve's Twilio channel so replies, approval prompts and media downloads stay in process.
- `agent/channels/twilio.ts`: `twilioChannel({ allowFrom: "*", onText, onVoice: () => null, ... })`, SMS only (voice is a later step). Routes `/eve/v1/twilio/{messages,voice,voice/transcription}` are wrapped to answer 404 unless `NEO_TWILIO_ENABLED=true`. eve checks `X-Twilio-Signature` with `TWILIO_AUTH_TOKEN` (the fixed mock token only when `MOCK_MODE` is on off a deployed environment; no token rejects every webhook). `onText` is the caller check: `resolveSmsCaller(from)` (verified `member_channels` row only) gives `{ authenticator: "twilio-sms", principalType: "user" | "member", principalId: userId ?? memberId, attributes: { tenantId, memberId, role } }`; any other number gets the fixed reply "This number isn't connected to Neo." (at most 3 per number per hour) and never reaches the model.

### Per-household monthly model spend cap (M3 slice 6, `_specs/v2-m3-cutover.md` section 6)

- `@neo/db`: `tenants.monthly_spend_cap_cents integer null` (migration **0027_spend_cap**, journal `when` `1793633166799`; CHECK null or 100 to 1,000,000; null = off, the default) and alert kind `spend_cap` (`alerts_kind_check` re-added with every existing kind). `spend.getSpendSettings(db, tenantId) -> { capCents, timeZone } | undefined`, `spend.setSpendCap(db, tenantId, capCents | null) -> boolean` (throws outside 100 to 1,000,000), `spend.monthSpendCents(db, tenantId, { start, end }) -> number` (estimated cents from `usage_events`, grouped by model), `spend.spendStatus(db, tenantId, now?) -> SpendStatus | undefined { capCents, timeZone, spentCents, percent, level, window }`.
- `@neo/core` (`spend.ts`): `estimateCostCents({ model, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens })` (catalog `pricing`; cache read 0.1x, write 1.25x of input; unknown model = dearest catalog rate), `monthWindow(now, timeZone | null) -> { start, end, month }` (household-time-zone calendar month; `month` is `YYYY-MM`), `spendLevel(spentCents, capCents | null) -> ok | warn | blocked` (80% / 100%), `isValidSpendCapCents`.
- apps/web (`lib/server/spend-cap.ts`): `spendView`, `setSpendCapCents`, `evaluateSpendCap(tenantId)` (raises `spend_cap` alerts at 80% medium / 100% high, dedupe key `spend_cap:<tenantId>:<YYYY-MM>:80|100`; null while the cap is off), `spendGate(tenantId)` (`blocked` from 100%; throws when the store is down, callers fail closed). `recordUsage` calls `evaluateSpendCap` after recording. Chat only: `POST /api/agent` answers 429 `{ error: "spend_cap_exceeded", limitCents, resetAt, message }` + `Retry-After`; `gateTurn` (eve) returns the templated message. Background jobs (forwarded-email triage, signals) and `POST /api/agent/confirm` are not gated.
- Console route (browser session + `requireHouseholdAdmin`): `GET /api/household/spend-cap` and `PUT /api/household/spend-cap { capCents: number | null }` -> `{ capCents, spentCents, percent, month, resetAt }`; 400 `invalid`, `invalid_spend_cap`; 403 `forbidden`. Audit `household.spend_cap_changed { from, to }`.
