# Spec for Model routing through Vercel AI Gateway

branch: claude/feature/model-routing

## Summary

Every model call leaves Neo through Vercel AI Gateway (`https://ai-gateway.vercel.sh`) using the existing Anthropic SDK with a changed base URL, an AI Gateway API key, and gateway-prefixed model ids. Every call carries the compliance policy (zero data retention, US inference region) and fails closed when the gateway cannot honor it. The chat turn is routed to a **tier** (small / medium / large) by TypeSafe AI's Jev evaluation model, with a deterministic rules fallback. A member's **preference** (cost / balanced / intelligence) and **model family** (Anthropic default; OpenAI, Kimi, Grok when enabled) turn the tier into a concrete model and effort. The chat shows which model answered. Direct Anthropic access remains available behind the feature flag for self-hosters and rollback. Plan: `_plans/phase-2-model-routing.md`.

## Functional requirements

### Gateway client (`@neo/core`)

```ts
export function gatewayEnabled(source?: EnvSource): boolean;           // NEO_MODEL_GATEWAY=true and AI_GATEWAY_API_KEY set
export function gatewayRegion(source?: EnvSource): "us" | "global";     // NEO_GATEWAY_REGION, default "us"
export function createModelClient(source?: EnvSource): Anthropic;      // gateway: baseURL + AI_GATEWAY_API_KEY; otherwise `new Anthropic()`
export function modelIdFor(model: CatalogModel, source?: EnvSource): string;   // gateway id, or the direct Anthropic id when the gateway is off
export function withGatewayOptions<T extends object>(params: T, model: CatalogModel, source?: EnvSource): T;  // adds providerOptions.gateway; no-op when the gateway is off
```
- `withGatewayOptions` adds `{ providerOptions: { gateway: { zeroDataRetention: true, inferenceRegion, order } } }` from the catalog entry. `inferenceRegion` is `{ scope: "zone", geoRegion: "us" }` unless `NEO_GATEWAY_REGION=global`, or the catalog entry declares `regionOverrides` (Grok: `{ providers: { xai: null, vertex: null } }`).
- One client per process, built by `createModelClient()`. `agent.ts`, `context-manager.ts` and `triage.ts` stop constructing their own; an injected `client` (tests, `MOCK_MODE`) still wins.
- When the gateway is on, the server-side refusal-fallback beta (`fallbacks: "default"`, `SERVER_SIDE_FALLBACK_BETA`) is not sent unless `NEO_ENABLE_FALLBACKS=true` is set explicitly (the spike decides whether it passes through; default off on the gateway).
- `usage` accounting reads `message.model` from every response (the gateway returns the slug) and reports it as the served model.

### Catalog and routing tables (`@neo/core`)

```ts
export type Tier = "small" | "medium" | "large";
export type RoutingPreference = "cost" | "balanced" | "intelligence";
export type ModelFamily = "anthropic" | "openai" | "kimi" | "grok";
export type RouterKind = "jev" | "rule" | "pinned";
export interface CatalogModel {
  id: string;                 // gateway id, e.g. "anthropic/claude-sonnet-5"
  directId?: string;          // Anthropic API id when the gateway is off, e.g. "claude-sonnet-5"; undefined for non-Anthropic
  displayName: string;        // "Sonnet 5"
  family: ModelFamily; tier: Tier;
  efforts: readonly Effort[]; // levels the model accepts (from the catalog's reasoning_options)
  order: readonly string[];   // gateway provider order
  regionOverrides?: Record<string, null>;  // Grok: providers exempt from the US pin
  pricing: { input: number; output: number };   // USD per M tokens, global
}
export interface RouteSignals { complexity?: number; stakes?: number; needsTools?: boolean; confidence?: number; reason?: string }
export interface Route {
  tier: Tier; family: ModelFamily; model: string; displayName: string; effort: Effort;
  preference: RoutingPreference; router: RouterKind; signals?: RouteSignals;
}
export const MODEL_CATALOG: Record<ModelFamily, Record<Tier, CatalogModel>>;
export const PREFERENCE_TABLE: Record<RoutingPreference, Record<Tier, { rung: Tier; effort: Effort }>>;
export function resolveRoute(input: { tier: Tier; preference: RoutingPreference; family: ModelFamily; router: RouterKind; signals?: RouteSignals }): Route;
export function pinnedRoute(kind: "compression" | "triage" | "playbook"): Route;   // Haiku 4.5 / Sonnet 5 / Opus 5 high
export function clampEffort(model: CatalogModel, effort: Effort): Effort;            // nearest listed level, higher on ties
export function displayNameFor(modelId: string): string;                             // falls back to the id
export function enabledFamilies(source?: EnvSource): ModelFamily[];                 // NEO_MODEL_FAMILIES, default ["anthropic"]
```
- Catalog contents and the preference table are in `_plans/phase-2-model-routing.md`. `NEO_MODEL_SMALL|MEDIUM|LARGE` override the Anthropic ladder ids (accepting either the direct or the gateway form). Legacy `NEO_AGENT_MODEL`, `NEO_TRIAGE_MODEL`, `NEO_COMPRESSION_MODEL` keep working as overrides of the large rung, triage and compression ids.
- `resolveRoute` falls back to the Anthropic family when the requested family is not enabled or the gateway is off (non-Anthropic models have no `directId`). The returned `Route.family` says which family was actually used.

### Agent loop (`@neo/core`)

- `RunAgentOptions.route?: Route`. When present it sets `model` and `effort` and is emitted as the first event: `{ type: "route", model, displayName, tier, effort, family, preference, router, reason? }`.
- The `usage` event gains `model?: string` (served model from `message.model`).
- `AgentResult.servedModel?: string` (the last response's `model`).
- Compression uses `pinnedRoute("compression")`, triage `pinnedRoute("triage")`, each through `modelIdFor` and `withGatewayOptions`.

### Router (`apps/web/lib/server/router.ts`)

```ts
export interface RouteTurnInput {
  text: string; hasAttachment: boolean; attachmentKind: "email" | "image" | "text" | null;
  priorTurns: number; previousVerdict: VerdictLabel | null; playbook: PlaybookId | null;
  preference: RoutingPreference; family: ModelFamily; signal?: AbortSignal;
}
export function routeTurn(input: RouteTurnInput, deps?: { evaluate?: EvaluateFn; now?: () => number }): Promise<Route>;
export function redactForRouting(text: string): string;   // URLs -> registrable domain, emails/phones masked, <= 4000 chars
export function rulesTier(input: RouteTurnInput): Tier;    // deterministic fallback
export function decideTier(answers: JevAnswers, confidence: Record<string, number> | undefined, needsToolsFloor: boolean): { tier: Tier; signals: RouteSignals };
```
- `playbook` set → `pinnedRoute("playbook")` with `preference` recorded; Jev is not called.
- `NEO_ROUTER=jev` (default when the gateway is on): `experimental_evaluate({ model: "typesafe-ai/jev", state, questions, providerOptions: { gateway: { zeroDataRetention: NEO_ROUTER_ZDR !== "false" } } })` with a 1.5 s timeout. State is the redacted excerpt plus `has_attachment`, `attachment_kind`, `prior_turns`, `previous_verdict`. Questions: `complexity` (score, 3 levels), `stakes` (score, 3 levels), `needs_tools` (boolean) with the criteria text from the plan.
- Decision: `tier = max(complexity, stakes)` using the highest-probability level; `needs_tools` (probability ≥ 0.5) lifts small to medium; confidence below 0.6 on either score lifts to at least medium; Jev error, timeout or `no_providers_available` → `rulesTier` with `router: "rule"`.
- `NEO_ROUTER=rules` or `MOCK_MODE=true`: `rulesTier` only (length, question marks, URL/email/phone presence, incident keywords such as "hacked", "drained", "password", attachment kind). `NEO_ROUTER=off`: always `medium`.
- One structured log line per routed turn with tier, router, confidence, and no message text.

### Persistence (`@neo/db`)

- Migration `0004_model_routing`: `memberships.routing_preference text not null default 'balanced'` and `memberships.model_family text not null default 'anthropic'`, both with check constraints; `turns.route jsonb`; `usage_events.tier text`. RLS: `memberships` and `turns` are already tenant-keyed; no new policies.
- `TenantDb.memberships.getPreferences(userId) → { routingPreference, modelFamily }` and `setPreferences(userId, patch)`.
- `ConversationStore.appendTurn(..., { route? })` stores the route; `get()` returns `lastRoute?: Route` so `/api/agent/confirm` reuses it.
- `usage.recordCheck` accepts `tier?` and records the served model in `model`.

### Web integration (`apps/web`)

- `streamAgentRun` loads the member's preferences, computes the route (`routeTurn`), passes `route` in `common`, persists it with the turn, records `usage_events.model` from `result.servedModel` (fallback: the route's model) and `tier`.
- `/api/agent/confirm` passes the stored `lastRoute`; no new Jev call.
- `env.ts`: `HAS_MODEL_CREDENTIALS` is true with `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` or with `NEO_MODEL_GATEWAY=true` + `AI_GATEWAY_API_KEY`. `/api/agent` returns 503 `agent_unavailable` when it is false and not `MOCK_MODE`.
- Settings: `GET /api/settings/routing` → `{ preference, family, families: [{ id, label, enabled, caveat?, ladder: [{ tier, displayName, pricing }] }] }`; `POST` `{ preference?, family? }` validates against the enum and `enabledFamilies()` (400 `bad_request`), any member may set their own row, returns the GET shape. Page `/settings/routing` (`RoutingSettings`): family cards (disabled ones read "coming soon"; Grok shows "US hosting not verifiable by the gateway"), then Cost / Balanced / Intelligence radio cards listing the three models each maps to. Linked from `AppShell` next to Forwarding.
- Chat: `chat-state.ts` stores `route` on the assistant message from the `route` event and the served model from `usage.model`; `messagesFromStored` reads `turns.route`. `MessageActions` renders a chip `"<displayName> · <tier> · <preference>"` with a `title` tooltip: "Routed by Jev: complexity 1/2, stakes 0/2", "Playbook: always <displayName>", or "Fallback rule". `MOCK_MODE` shows `neo-mock-model`.

### Budget and errors

- A gateway 402 (`quota_for_entity_exceeded`) is mapped to the existing user-safe error path with the message "Neo's monthly AI budget is used up. Please try again after it resets." and a `usage.budget_exhausted` audit event (one per tenant per day).
- A gateway 400 `no_providers_available` / region failure is logged with the model id and surfaces as the generic error; it should never happen with the shipped catalog.

## Possible Edge Cases

- Jev returns answers without `providerMetadata.typesafe.confidence` → treated as low confidence → at least medium.
- Jev probabilities sum to 0.99 (rounded) → pick the max, do not renormalize.
- A member's stored family is later removed from `NEO_MODEL_FAMILIES` → `resolveRoute` falls back to Anthropic and the chip shows the Anthropic model; settings page shows the stored choice as disabled.
- Gateway off (self-hosting) with a non-Anthropic family stored → Anthropic ladder; `Route.family` is `anthropic`.
- Non-Anthropic model returns no `thinking` blocks → the `thinking` event is simply never emitted.
- `cache_control` on a non-Anthropic model → ignored by the gateway; cache token counters stay 0.
- Resume after confirmation when `lastRoute` is missing (turn persisted before this change) → route the resume with rules, `router: "rule"`.
- The pending turn was routed to a family that is now disabled → resume falls back like the previous case.
- Jev state over 32k tokens → impossible after the 4k-character cap.
- Redaction must not break the router on messages that are only a URL: the domain remains and `needs_tools` still fires.

## Acceptance Criteria

- With `NEO_MODEL_GATEWAY=true` every request in AI Gateway Logs shows a ZDR planning line, `inferenceEndpoint.geoRegion: us` (except Grok), and `finalProvider` from the family's `order`.
- With the gateway off, behaviour is unchanged from Phase 1 (same model ids, same requests) except the new `route` event and chip.
- A "thanks!" turn routes small; "is https://example.com safe?" routes medium with `needsTools`; "my bank account was drained after I entered my password on a link" routes large; a playbook turn is large / high without a Jev call.
- Changing the preference in settings changes the model on the next turn; the chip and `turns.route` agree with AI Gateway Logs.
- Compression and triage requests always use Haiku 4.5 and Sonnet 5 regardless of preference and family.
- `pnpm turbo run typecheck lint test build` passes with `MOCK_MODE=true` and no network.

## Open Questions

- Does the refusal-fallback beta pass through the gateway? (Spike; default off on the gateway until known.)
- Do OpenAI, Kimi and Grok honor `output_config.effort` and Anthropic-style structured outputs through the translation layer well enough for the agent loop? (Spike gates `NEO_MODEL_FAMILIES`.)
- When does Jev get a ZDR endpoint? Until then the router runs on rules in production.

## Testing Guidelines

Create test files in the package `test/` folders for the new feature, and create meaningful tests for the following cases, without going too heavy:
- `packages/core/test/routing.test.ts`: every (preference, tier, family) cell resolves to a catalog model; `clampEffort` on Kimi K3 and Grok 4.6; `pinnedRoute` ids; `enabledFamilies` parsing; fallback to Anthropic when the family is disabled or the gateway is off; `modelIdFor` direct vs gateway ids; `withGatewayOptions` shape including the Grok region override and `NEO_GATEWAY_REGION=global`.
- `packages/core/test/agent.test.ts` additions: a `route` option sets `model` and `effort` on the request, emits the `route` event first and `usage.model` from the mock message; the fallbacks beta is absent when the gateway is on.
- `packages/core/test/triage.test.ts` / `context-manager.test.ts`: pinned ids and gateway options on the built requests.
- `apps/web/test/router.test.ts`: `redactForRouting` cases; `decideTier` for the three acceptance prompts using `Experimental_EvaluationMockModelV4`; low confidence lifts; timeout and error fall back to rules; playbook skips Jev; `MOCK_MODE` uses rules.
- `apps/web/test/settings-routing.test.ts`: GET shape, POST validation, disabled family rejected.
- `apps/web/test/chat-state.test.ts` additions: `route` event and `usage.model` land on the message; stored `turns.route` rebuilds the chip.
- `packages/db/test`: migration `0004` applies under `app_user` in PGlite; preferences round-trip; `appendTurn` stores `route` and `get` returns `lastRoute`.
