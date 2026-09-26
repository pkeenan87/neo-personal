# Phase 2 — Vercel AI Gateway and effort-based model routing

Status: planned 2026-09-26, approved by the owner the same day. Parent plan: `phase-0-and-roadmap.md` (cost controls, "AI budget"). Spec: `_specs/model-routing.md`. Interfaces: `docs/contracts.md` "Package contracts (Phase 2)". Exit criterion: **every model call goes through Vercel AI Gateway to a US-hosted, zero-data-retention provider, the chat turn is routed to a model tier by effort, and the user sees which model answered.**

## Why

Neo calls Anthropic directly from three places with a model pinned per call site by env var, and the only spend control is the per-tenant usage cap. The owner wants one place to cap and observe spend, a hard guarantee that prompts only reach US-hosted providers with zero data retention (ZDR), routing of each chat turn to a curated model tier by effort, a per-user bias toward cost, intelligence or balance, and a Cursor-style indicator of which model answered.

## Verified facts (live gateway catalog and Vercel docs, 2026-09-26)

- The gateway serves the **Anthropic Messages API** at `https://ai-gateway.vercel.sh` for the stock `@anthropic-ai/sdk`. Model ids gain a creator prefix (`anthropic/claude-opus-5`, `anthropic/claude-sonnet-5`, `anthropic/claude-haiku-4.5`, note the dot). `cache_control`, `thinking`, `output_config.effort` and `output_config.format` (GA structured outputs), tools and streaming pass through. Gateway options travel in the request body as `providerOptions.gateway`.
- The Messages format is translated for **any** model on the gateway: `thinking` maps to the target's native reasoning, `output_config.effort` to effort-based models, tools and structured outputs translate. `cache_control` is honored only by Anthropic-family providers; the others cache implicitly.
- **ZDR**: `providerOptions.gateway.zeroDataRetention: true` fails closed (`no_providers_available`). Free per request on Pro (the team is on Pro). `anthropic/claude-fable-5*` has no ZDR anywhere.
- **US only**: `providerOptions.gateway.inferenceRegion: { scope: "zone", geoRegion: "us" }` fails closed with 400 when a model has no US endpoint; the response reports `inferenceEndpoint.geoRegion`. Regional pricing applies: Claude is +10% over global.
- **Jev** (`typesafe-ai/jev`): TypeSafe AI's evaluation model. AI SDK 7 `experimental_evaluate({ model, state, questions })`, question types `boolean`, `choice`, `score`; probabilities per answer, confidence in `providerMetadata.typesafe.confidence`; $0.042 per M input tokens, no output charge; state limit 32k tokens. Test double: `Experimental_EvaluationMockModelV4` from `ai/test`.
- **Jev has no ZDR endpoint today** (`zdr: "none"`, only endpoint `digitalocean` with `has_zdr: false`) although the docs say ZDR is available. A ZDR-pinned Jev call fails until Vercel changes that.
- Other families: OpenAI GPT-6 Luna / Sol / Astra have a ZDR + US `openai` endpoint. Kimi K3 has ZDR + US endpoints on `baseten`, `fireworks`, `bedrock`; other Kimi models report no regions. Grok lives under `spacexai/*`, is ZDR on `xai` and `vertex`, but no Grok endpoint reports inference regions, so a US pin fails it.
- Budgets: `vercel ai-gateway budgets set` per team, project (OIDC only), API key or user; exceeded returns HTTP 402 `quota_for_entity_exceeded`. API-key spend never counts toward a project budget, so with an API key the cap goes on the key.

## Function inventory and effort tiers

| # | Function | Where | Today | Tier | Routed? | Why |
|---|---|---|---|---|---|---|
| 1 | Chat turn (agent loop, up to 20 tool iterations) | `runAgentLoop` via `streamAgentRun` | Opus 5, effort medium | small / medium / large by Jev | **Yes** | The only surface where difficulty varies widely; this is where the money is. |
| 2 | Playbook turns | `agentEffort()` returns `high` for a playbook | Opus 5, effort high | large, effort high | No, pinned | Already flagged high-stakes by the product; skipping Jev saves a call and avoids a downgrade on an incident. |
| 3 | Resume after confirmation | `resumeAfterConfirmation` | as chat | reuse the turn's route | No | The route belongs to the turn; re-classifying mid-tool-loop could switch models. |
| 4 | Context compression | `callCompressionModel` | Haiku 4.5 | small, pinned | No, overkill | Mechanical summarisation inside the loop; routing adds latency for no gain. |
| 5 | Anchor summarisation | same module | Haiku 4.5 | small, pinned | No, overkill | Same. |
| 6 | Forwarded-email triage (Inngest) | `runTriage` | Sonnet 5, low then medium | medium, pinned | No | Input is analyzer output, not a request; the retry is already an effort ladder; background spend must not follow a member's chat preference. |
| 7 | SMS triage (unwired) | `runTriage` | Sonnet 5 | medium, pinned | No | Same as 6. |
| 8 | Conversation titles | `titleFromMessage` (truncation) | no model | n/a | No | Not an LLM call; if it becomes one it is small/pinned. |
| 9 | Injection scan, verdict extraction | regex | no model | n/a | n/a | Completeness. |
| 10 | The router | new | none | Jev | n/a | ~4k input tokens per turn at $0.042/M, about $0.0002. |

## Model catalog: four families, Anthropic primary

| Family | small | medium | large | US pin |
|---|---|---|---|---|
| **Anthropic** (default) | `anthropic/claude-haiku-4.5` $1/$5 | `anthropic/claude-sonnet-5` $2/$10 | `anthropic/claude-opus-5` $5/$25 (`claude-opus-5.5` $4/$20 selectable by env) | yes, verifiable |
| **OpenAI** | `openai/gpt-6-luna` $0.10/$0.50 | `openai/gpt-6-sol` $2/$10 | `openai/gpt-6-astra` $10/$50 | yes (`openai` endpoint) |
| **Kimi** | Anthropic Haiku 4.5 | `moonshotai/kimi-k3` $3/$15 | `moonshotai/kimi-k3` $3/$15, effort high | yes (`baseten`, `fireworks`, `bedrock`) |
| **Grok** (experimental) | `spacexai/grok-4.1-fast-reasoning` $0.20/$0.50 | `spacexai/grok-4.7` $1.20/$3.60 | `spacexai/grok-4.6` $2/$6, effort xhigh | **no**: region pin relaxed for `xai`/`vertex`; xAI hosting is US but the gateway cannot verify it |

Preference shifts one rung along the family ladder (clamped):

| Tier | cost | balanced (default) | intelligence |
|---|---|---|---|
| small | small, low | small, low | medium, low |
| medium | medium, low | medium, medium | large, medium |
| large | medium, medium | large, medium | large, high |

Effort is clamped to what the model's `reasoning_options` list (Kimi K3 has no `medium`; Grok 4.6 tops out at `xhigh`). Compression stays Haiku 4.5 and triage stays Sonnet 5 in every family and preference. Non-Anthropic families ship behind `NEO_MODEL_FAMILIES` (default `anthropic`) until the spike below passes them.

## How Jev routes a chat turn

State: a redacted excerpt of the latest user message (URLs reduced to registrable domains, emails and phone numbers masked, capped at about 4k characters) plus structural signals (attachment kind, conversation depth, previous verdict). Never the raw conversation.

Questions: `complexity` (score, 3 levels), `stakes` (score, 3 levels), `needs_tools` (boolean). Decision: `tier = max(complexity, stakes)`; `needs_tools` lifts small to medium; confidence below 0.6 on either score lifts to at least medium; playbooks skip Jev and are large. Fail-open to medium with `router: "rule"` on error, 1.5 s timeout, or no ZDR provider. `NEO_ROUTER=jev|rules|off`. The Jev call sets `zeroDataRetention: true`; while Jev has no ZDR endpoint the router runs on rules. `NEO_ROUTER_ZDR=false` is the owner's opt-out.

## Provider policy on every call

`zeroDataRetention: true`, `inferenceRegion: { scope: "zone", geoRegion: "us" }` (`NEO_GATEWAY_REGION=us|global`), `order` per family (`anthropic, bedrock, vertexAnthropic, claudeaws` / `openai` / `baseten, fireworks, bedrock`; Grok relaxes the pin per provider). No `only`. `metadata.user_id: hashPii(userId)` stays.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Integration surface | Keep `@anthropic-ai/sdk`, point it at the gateway | The agent loop, caching, thinking, structured outputs and injection defenses stay intact; the gateway translates the format for the other families. AI SDK 7 is added only for Jev. |
| Catalog | Four families, Anthropic default and primary | Owner's request; other families gated by an allowlist until tested. |
| What is routed | Chat only | See inventory. |
| Preference scope | Per member per household on `memberships` | Tenant-scoped by construction; households share a budget but members differ. |
| Compliance | ZDR + US pin, fail closed, +10% on Claude | A verifiable guarantee from response metadata beats an assumption. |
| Jev and ZDR | Fail closed, rules fallback | Owner's choice; Jev switches on automatically when its ZDR flag appears. |
| Auth | Gateway API key with a key budget | OIDC tokens rotate and do not fit a long-lived SDK client; key budgets are the enforceable cap. Replaces the deferred Anthropic spend limit. |
| Rollout | Feature flag `NEO_MODEL_GATEWAY` | Direct Anthropic keeps working for self-hosters and as rollback. |

## Sequencing and parallel work

0. **Spike** (`scripts/gateway-spike.ts`, needs `AI_GATEWAY_API_KEY`, a few dollars): verify through the gateway with the Anthropic SDK: adaptive thinking `display: summarized`, `output_config.effort` + `format`, `cache_control` hit rates, `metadata.user_id`, the refusal-fallback beta header, ZDR + region metadata in the response, regional prices for OpenAI/Kimi, Jev with and without ZDR. Then run the tool loop and the prompt-injection tests against each non-Anthropic family. Results are recorded in the spec and gate `NEO_MODEL_FAMILIES`.
1. **This plan, the spec and the contracts** (`docs/contracts.md` Phase 2 section) merge first.
2. Five build agents in parallel worktrees, then integration, as in Phases 0 and 1:

| Agent | Owns |
|---|---|
| A. core-routing | `packages/core`: `routing.ts`, `client.ts`, `config.ts` gateway settings, `agent.ts` / `context-manager.ts` / `triage.ts` changes, `types.ts` events, tests |
| B. db-settings | `packages/db`: migration `0004_model_routing`, membership preference helpers, `turns.route`, `usage_events.tier`; `apps/web`: `/api/settings/routing`, `/settings/routing`, `RoutingSettings` |
| C. web-router | `apps/web/lib/server/router.ts`: Jev call, redaction, thresholds, rules fallback, mock, tests |
| D. web-run | `apps/web`: `agent-run.ts` integration, route persistence and resume, `route` / `usage.model` in `chat-state.ts`, model chip in `MessageActions.tsx`, `env.ts` credentials check, tests |
| E. docs | `.env.example`, `docs/self-hosting.md`, `docs/deployment.md`, `SECURITY.md`, `/privacy` processors, `CHECKLIST.md`, `CLAUDE.md` model line, spike script skeleton |

3. Integration PR, preview deployment with `NEO_MODEL_GATEWAY=true`, live checks (AI Gateway Logs: `finalProvider`, `geoRegion: us`, "ZDR requested"), then production.

## Owner prerequisites (CHECKLIST.md)

Create a gateway API key with a budget (`vercel ai-gateway api-keys create --name neo-prod --limit 25 --refresh-period monthly --alert-thresholds 75,100`), set `AI_GATEWAY_API_KEY` and `NEO_MODEL_GATEWAY=true` in Production and Preview, keep `ANTHROPIC_API_KEY` for one release as rollback, run migration `0004`.
