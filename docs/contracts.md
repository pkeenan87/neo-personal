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
export function encryptArtifact(key: Uint8Array, plaintext: Uint8Array, aad: string): Uint8Array;
export function decryptArtifact(key: Uint8Array, blob: Uint8Array, aad: string): Uint8Array;  // throws ArtifactDecryptError
export class ArtifactDecryptError extends Error {}

// Bulk triage: one structured-output call on NEO_TRIAGE_MODEL (default claude-sonnet-5), effort low
export function runTriage(input: { evidence: unknown; evidenceKind: "email" | "sms"; guidance: string; client?: Anthropic; model?: string; signal?: AbortSignal; maxTokens?: number }): Promise<{ verdict: Verdict; usage: AgentUsage; model: string; attempts: number; fallback: boolean }>;
export const TRIAGE_SYSTEM_PROMPT: string;
export function triageModel(): string;                                                   // NEO_TRIAGE_MODEL

// Context manager: image blocks count 1600 tokens; past the compression trigger, images before the latest
// user turn become "[image omitted]" text blocks first, and Haiku compression runs only if that is not enough.
export const IMAGE_OMITTED_TEXT: string;
export function omitOlderImages(messages: readonly MessageParam[]): { messages: MessageParam[]; omitted: number };
```

Notes:
- `masterKeyFromEnv` accepts standard or URL-safe base64, returns `undefined` when unset/blank, and **throws** when set but not 32 bytes. HKDF uses a fixed salt (`neo-artifact-hkdf-salt-v1`) plus info `neo-artifact-v1:<tenantId>`. Also exported: `ARTIFACT_CIPHERTEXT_OVERHEAD` (32 bytes).
- `runTriage` returns `{ verdict, usage, model, attempts, fallback }` (`fallback: true` = the `triage_failed` verdict). It takes `maxTokens?` (default 4096, not 2048: adaptive thinking shares the budget). Request: `messages.create({ model, max_tokens, system, messages: [one user message], thinking: { type: "adaptive" }, output_config: { effort: "low" | "medium", format: { type: "json_schema", schema: verdictJsonSchema } } })` (non-beta; SDK type `OutputConfig`). `subject_type` is forced to `evidenceKind`. Refusal / `max_tokens` / invalid JSON / schema mismatch → one retry at `medium` → fallback. API errors are thrown (so Inngest retries). Without `client`, `MOCK_MODE=true` uses `createMockTriageClient()` (verdict from analyzer heuristic codes).
- Also exported: `DEFAULT_TRIAGE_MODEL`, `DEFAULT_TRIAGE_MAX_TOKENS`, `buildTriageRequest`, `parseTriageResponse`, `triageFailedVerdict`, `createMockTriageClient`, types `RunTriageInput`, `TriageResult`, `TriageEvidenceKind`. `@neo/core` now depends on `@neo/verdict`.
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
- `saveVerdict` validates with `VerdictSchema` (throws on invalid), sets `raw_ref` from `artifactId` when absent, and throws on DB errors (callers that must not fail catch). `verdictQueries.list` throws `InvalidCursorError` on a malformed cursor (route → 400); the cursor carries microsecond precision. `summary` covers whole UTC days (today and the previous `sinceDays - 1`), `perDay` has one entry per day (zero-filled), `topIndicators` / `topDomains` count verdicts (not occurrences), domains lowercased; it also takes `now?`. `remove` does not delete the linked artifact (the app does, via `ArtifactStore.delete`). Types exported: `VerdictRow` (`body: Verdict`), `VerdictSummary`, `VerdictListOptions`, `HouseholdMember`, `InboundMessageRow`, `InboundStatus`, `VerdictSource`, `ArtifactKind`.
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
- `agent.ts`, `context-manager.ts` and `triage.ts` obtain their default client from `createModelClient()`; an injected `client` still wins. Compression and triage build their requests from `pinnedRoute(...)`, `modelIdFor` and `withGatewayOptions`.

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
- A `Bearer neo_dt_…` header is resolved before DEV_AUTH_BYPASS and decides alone (session, 403 `insufficient_scope`, or 401), so device clients can be developed against MOCK_MODE with the bypass on.
- Server helpers: `lib/server/devices.ts` (db-or-memory dispatch for every @neo/db devices function, `toDeviceItem(d, now?)`, `toEnrollmentCodeItem`, `deviceStatus`); in-memory twin `lib/server/memory-devices.ts`.

### HTTP contract: devices (`_specs/device-enrollment.md`)

Wire types in `apps/web/lib/household-types.ts`:
- `DeviceItem = { id, userId, memberName, kind, platform, name, clientVersion, enrollment, enrolledByName, createdAt, lastSeenAt, status: "active" | "offline" | "never_seen" }`
- `EnrollmentCodeItem = { id, userId, memberName, createdAt, expiresAt }`

JSON errors `{ error, code }`.

- **Household view:** `GET /api/household` adds `devices: DeviceItem[]` (owner: all; member: their own) and `enrollmentCodes: EnrollmentCodeItem[]` (owner only).
- **Enrollment codes (owner, browser session):**
  - `POST /api/household/members/[userId]/enrollment-codes` → 201 `{ id, code, expiresAt, memberName }`; 404 `not_found`; 409 `code_limit` | `device_limit`.
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
SIGNAL_TYPES = ["page", "software", "remote_session", "permission"] as const;
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
