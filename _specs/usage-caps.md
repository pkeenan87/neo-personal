# Spec for Usage Caps

branch: claude/feature/usage-caps

## Summary

Neo launches free with open signup, so per-tenant usage caps are the only thing standing between a stranger and the operator's Claude bill. Phase 0 enforces two caps per household tenant: a **monthly check cap** (number of agent turns) and a **daily token cap** (input plus output tokens). Both are set by env var, checked before the agent runs, and return HTTP 429 with a machine-readable reason when exceeded. Every cap hit writes an audit event.

Implementation lives in `@neo/db` as `usage.checkCaps` and `usage.recordCheck` (see `docs/contracts.md`), backed by the `usage_events` table, and is called by `apps/web` `/api/agent` and `/api/agent/confirm`. This replaces Neo's Cosmos-backed `usage-tracker.ts`.

## Functional requirements

Configuration
- `USAGE_CAP_MONTHLY_CHECKS` (default `50`): agent checks allowed per tenant per calendar month, UTC.
- `USAGE_CAP_DAILY_TOKENS` (default `300000`): `input_tokens + output_tokens` allowed per tenant per UTC day. Cache read and cache creation tokens are recorded separately and do not count toward the cap in Phase 0.
- Values are read on each call (not cached at module load), so changing the env var and redeploying config changes behaviour with no code change.
- Parsing: a non-negative integer. Unset, empty, negative, or non-numeric values fall back to the default and log a `warn` once per process. `0` means "no usage allowed" (useful to pause a deployment).

What counts
- A **check** is one `POST /api/agent` request that passes the cap check and reaches the agent loop, regardless of how many tool calls or Claude calls it makes. `POST /api/agent/confirm` (resuming after a confirmation) is **not** a new check.
- **Tokens** are all Claude API tokens consumed while serving the tenant: the agent loop (summed across every model call in the turn, from `AgentEvent` `usage` events), compression calls made by `prepareMessages` for that conversation, and confirm resumptions.
- A turn that errors or is aborted by the client still records the tokens actually consumed and still counts as a check once the agent loop started.
- Requests rejected before the agent loop (auth failure, cap exceeded, injection guard block) record nothing.

Enforcement (`usage.checkCaps(db, tenantId)`)
- Returns `{ allowed: true, remaining: { monthlyChecks, dailyTokens } }` or `{ allowed: false, reason: "monthly_checks" | "daily_tokens", remaining, resetAt }`. `resetAt` is the start of the next UTC month or day. If both caps are exceeded, `reason` is `"monthly_checks"` (the longer wait).
- Monthly checks: `count(*)` of check events for the tenant with `created_at >= start of current UTC month`. Daily tokens: `sum(input_tokens + output_tokens)` for the tenant with `created_at >= start of current UTC day`. Both queries go through `tenantScoped` and use an index on `(tenant_id, created_at)`.
- `/api/agent` order (from `docs/contracts.md`): auth, then `checkCaps`, then `scanUserInput`, then the agent. `/api/agent/confirm` checks only the daily token cap (a user must be able to finish or cancel a pending action; cancelling never needs a cap check).
- Caps are soft at the boundary: a check that starts with 1 token remaining is allowed and may finish over the cap. The overshoot is bounded by one turn's tokens (`maxTokens` and the context limit) times concurrent requests.

Recording (`usage.recordCheck(db, input)`)
- Called once per turn after the stream ends (success, error, or abort), with `{ tenantId, userId, conversationId?, model, inputTokens, outputTokens }` totals for the turn, plus cache token fields. Writes one `usage_events` row with `kind: "check"`. Confirm resumptions write `kind: "resume"` rows that count tokens but not checks.
- Recording failure must not break the user's response; it logs an `error` with the tenant id hash and the totals.
- In `MOCK_MODE=true` recording still happens (with mock token counts), so caps are testable locally.

429 semantics
- When not allowed, the route returns status **429** before any streaming begins, with:
  - Header `Retry-After: <seconds until resetAt>`.
  - JSON body: `{ "error": "usage_cap_exceeded", "reason": "monthly_checks" | "daily_tokens", "limit": <number>, "resetAt": "<ISO 8601 UTC>", "message": "<one friendly sentence>" }`.
- Messages: monthly: "You've used all of this month's free checks. They reset on <date>." Daily: "You've hit today's usage limit. It resets at midnight UTC." The UI shows the message and the reset time in place of the chat input, not a generic error toast.
- 429 is also the status for per-IP rate limiting (future), distinguished by `error` value.

Audit event on cap hit
- On each rejected request, write an `audit_events` row `{ tenant_id, user_id, action: "usage.cap_hit", metadata: { reason, limit, used, resetAt } }`.
- To avoid log flooding from retries, write at most one `usage.cap_hit` per tenant per reason per period (month or day): check for an existing row in the current period first. The 429 is returned regardless.
- Also log a structured `warn` (`usage_cap_hit`, tenant id hashed) so operators can alert on it from Vercel logs.

Visibility
- `GET /api/usage` (authenticated) returns `{ monthlyChecks: { used, limit, resetAt }, dailyTokens: { used, limit, resetAt } }` for the session's tenant, so the UI can show "12 of 50 checks used this month". Tokens are shown to users as a percentage, not raw counts.

## Possible Edge Cases

- Two requests from the same tenant arrive together with one check remaining: both pass `checkCaps`, both run, the tenant ends at limit + 1. Accepted in Phase 0 (bounded overshoot). If abuse shows up, move to a `SELECT ... FOR UPDATE` on a per-tenant counter row or an Upstash atomic counter.
- Month and day boundaries: all periods are UTC. A request that starts at 23:59:59 UTC counts on the day it started (record `created_at` at turn start, not end).
- Env var changed mid-month to a lower value: tenants already over the new limit get 429 immediately; lowering never deletes history.
- Env var set to a huge number or `0`: honoured (huge = effectively unlimited; `0` = pause).
- Stream aborted by the client halfway: tokens reported so far are recorded; the check counts.
- Anthropic returns an error before any tokens are used: the check still counts (the loop started); tokens are 0. This keeps retry-spam bounded.
- A tenant with several members: caps are per tenant (household), so members share the pool. The 429 message says "your household".
- `usage_events` table missing or DB unavailable during `checkCaps`: fail **closed** (503 with `error: "usage_unavailable"`), because failing open would remove the only spend control.
- Clock skew between Vercel regions and Postgres: use the database's `now()` for period boundaries and `created_at`.

## Acceptance Criteria

- With `USAGE_CAP_MONTHLY_CHECKS=2`, the third `POST /api/agent` in a month returns 429 with `reason: "monthly_checks"`, a correct `Retry-After`, and `resetAt` at the next UTC month start, and the agent is not invoked.
- With `USAGE_CAP_DAILY_TOKENS=1000` and a turn that consumed 1200 tokens, the next request returns 429 with `reason: "daily_tokens"`.
- `/api/agent/confirm` with `approved: false` succeeds even when caps are exhausted.
- Exactly one `usage.cap_hit` audit event is written per tenant, reason, and period, however many requests are rejected.
- Changing either env var changes enforcement on the next deployment with no code change; invalid values fall back to defaults with a warning.
- Every agent turn writes exactly one `usage_events` row with the turn's total tokens, including aborted turns.
- If the usage query fails, the request is rejected with 503, not allowed through.
- `GET /api/usage` returns the tenant's usage and limits; another tenant's usage is never visible.

## Open Questions

- Launch defaults (plan open item 4): keep 50 checks / 300000 tokens until Phase 0 measures real per-check token costs, then tune. The plan's cost estimate suggests 20 checks/month is affordable; 50 may be generous.
- Should cache-read tokens count at a discount toward the daily cap (they cost ~10% of input)? Proposal: record now, decide once real numbers exist.
- Per-user caps inside a household (so one member cannot exhaust the pool)? Defer to Phase 2 with invites.
- Global kill switch (all tenants) beyond setting both caps to `0`? Setting `USAGE_CAP_MONTHLY_CHECKS=0` is sufficient for Phase 0.

## Testing Guidelines

Create test file(s) in `packages/db/test/` (and `apps/web/test/` for the route), and create meaningful tests for the following cases, without going too heavy:

- `checkCaps` allows under both caps and returns correct `remaining`.
- `checkCaps` denies with `monthly_checks` at the monthly limit and `daily_tokens` at the daily limit; `monthly_checks` wins when both are exceeded.
- Period boundaries: events from last month and yesterday (UTC) are not counted.
- Env parsing: unset, empty, negative, and non-numeric fall back to defaults; `0` denies everything.
- `recordCheck` writes one row per turn; `resume` rows count tokens but not checks.
- Tenant isolation: usage from tenant A never affects tenant B's `checkCaps`.
- Route: `/api/agent` returns 429 with the documented body and `Retry-After`, and the agent loop mock is not called.
- Audit: repeated rejections in one period write one `usage.cap_hit` event.
- DB failure in `checkCaps` makes the route return 503.
