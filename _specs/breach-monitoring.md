# Spec for breach-monitoring

branch: hermes/feature/breach-monitoring
plan: `_plans/deferred-roadmap-items.md` (step 2)

This is a documentation-only proposal. The migration number is the **next free number at implementation time**. Ship with deterministic mock mode; HIBP plan and production RPM are owner decisions.

## Functional requirements

### Verified addresses, cryptography and lifecycle

- Monitor the sign-in address only when `users.emailVerified` is non-null, regardless of whether verification came from Google or a magic link. Other addresses require confirmation through a verification link before lookup.
- The stored address digest is `HMAC-SHA256` using `deriveKey(masterKey, "neo-breach-addr-v1", tenantId)` over the trimmed, lowercased address. Never use plain SHA, unsalted address hashes or `deriveTenantKey` directly. Fail closed when `NEO_MASTER_KEY` is unset in a deployed environment (a deterministic dev key is used otherwise, as in weekly-digest payloads); never store plaintext addresses. Retain the address only as authenticated ciphertext using `deriveKey(masterKey, "neo-breach-address-encryption-v1", tenantId)` and AAD `neo:breach-address:v1:<tenantId>:<userId>:<addressId>` so checks and verification mail can use it.
- Address uniqueness is `(tenant_id, user_id, digest)`. Same address in different households is allowed. Because the stored digest is tenant-scoped, dedupe only the HIBP lookup—not household ownership—using `deriveGlobalBreachQueryDigest` exported from `apps/web/lib/server/`, an HMAC-SHA256 over the same normalized address with a key derived by `deriveKey(masterKey, "neo-breach-global-v1", "")` from `NEO_MASTER_KEY` (no tenant component). Its only uses are in-process grouping and in-flight HIBP-query dedupe; it is never sent to Inngest. Never persist it in Neo tables or logs, expose it, or use it to share verification limits or observations. The deduped query result fans out to each tenant, where observations are written separately.
- A verification link contains a cryptographically random 256-bit token; store only its hash. It expires after 24 hours, is single-use, and binds the tenant, user and address. Confirmation requires `requireBrowserApiSession`. Limit sends to 3 per address per day using that address's tenant-scoped stored digest, so the cap does not reveal cross-household address use. At most 5 extra addresses per user.
- Removing an address or leaving/removal from a household hard-deletes the address and its observations. Household leave/removal performs this through `household.ts`. Keep breach observations only while their address exists. A queued check must re-check address eligibility before calling HIBP.

### HIBP checks and abuse limits

- Query only `GET https://haveibeenpwned.com/api/v3/breachedaccount/{email}` with the address URL-encoded as one path segment, subscription key in `hibp-api-key`, and a descriptive `User-Agent` from its own environment variable. Request `truncateResponse=false&IncludeUnverified=false` (full data classes, verified breaches only). Validate only the response fields Neo reads and ignore unknown fields. With `MOCK_MODE` or no `HIBP_API_KEY` outside a deployed environment, use the mock fixtures; deployed without a key fails closed. Do not use domain, paste, stealer-log or Pwned Passwords endpoints.
- `HIBP_RPM` defaults to 10; apply one function-wide throttle, and one HIBP request per same-address group across households (`checkGroup` performs a single lookup). Event IDs are `<run date>:<tenantId>:<addressId>` of the group's first target (plus retry attempt), containing no address-derived value; event data contains target identifiers and retry attempt only. The check function has `retries: 1`. `Retry-After` must be capped at one hour. Do not exceed configured RPM. Owner decides subscription plan/RPM; ship mock mode without live credentials.
- 200 with records and empty 200 are successful; 404 means clean/not found. 429, network, 5xx and 503 retry with bounded backoff; 401/403 are configuration failures and never clean; validated malformed/invalid 400 is non-retryable. Never persist raw response bodies or represent failed/stale checks as clean.
- Mock mode with no `HIBP_API_KEY` uses deterministic fixtures for addresses ending `@example.com` and no breaches for other addresses; no external call.

### Stored state and alerts

- Use tables `monitored_addresses` and `breach_observations`. Explicit columns:
  - `monitored_addresses`: `id`, `tenant_id`, `user_id`, `digest`, `encrypted_address`, `verification_source`, nullable `verified_at`, nullable `verification_token_hash`, nullable `verification_expires_at`, `verification_send_times` (`timestamptz[]`, non-null), `created_at`, `updated_at`, `last_checked_at`, `last_successful_check_at`, `check_status`. The `verification_send_times` timestamp array retains the last three sends per tenant digest and enforces the exact rolling 24-hour cap across same-household members and app instances. Address material is never plaintext; encrypt it under a separate HKDF label and bind AAD to tenant/user/address. A pending extra address is not queried; successful verification atomically consumes the matching unexpired token hash and clears the token fields.
  - `breach_observations`: `id`, `tenant_id`, `monitored_address_id`, `breach_name`, `breach_domain`, `breach_date`, `added_date`, `data_classes`, `first_seen_at`, `last_seen_at`, `retired_at`. No passwords, pastes, raw responses, address copies or descriptions.
- Foreign keys: `monitored_addresses.tenant_id → tenants.id ON DELETE CASCADE`; `monitored_addresses.user_id → users.id ON DELETE CASCADE`; `(monitored_addresses.tenant_id, monitored_addresses.user_id) → memberships(tenant_id, user_id) ON DELETE CASCADE`; `breach_observations.tenant_id → tenants.id ON DELETE CASCADE`; `(breach_observations.tenant_id, breach_observations.monitored_address_id) → monitored_addresses(tenant_id, id) ON DELETE CASCADE`. Index monitored addresses on `(tenant_id,user_id)`; unique `(tenant_id,user_id,digest)` and non-null `verification_token_hash`; index `verification_expires_at`; unique observation `(tenant_id,monitored_address_id,breach_name)`; index observations `(tenant_id,monitored_address_id,first_seen_at)`.
- New tenant tables are registered in `tenantTables`, have `tenant_isolation` RLS and explicit `app_user` grants (or document default privileges from `create-app-user.sql`). All direct member reads/writes are tenant-scoped. The only global helpers are bounded `SECURITY DEFINER` functions: the scheduler lists verified tenant/user/address identifiers only, and daily cleanup clears expired token hashes only. Neither returns or logs email, ciphertext, or a global digest.
- Proposed new alert kind `breach_detected`: generate one alert per newly observed breach. Password data class → `high`, otherwise `medium`; alert text uses static checklist guidance. Breach names may appear in owner email, subject to existing alert threshold. Owner email title/body contain breach name only and never an address or partial address. `deliverAlert` emails owners only; members see their own feed alerts. Do not send member emails through this owner alert path. If approved, implementation adds the kind to `ALERT_KINDS`, drops and re-adds `alerts_kind_check` in the migration, adds its template in `apps/web/lib/server/alerts/templates.ts`, and mirrors it in `memory-alerts.ts`.
- If HIBP retires a breach, retain its observation and do not re-alert. Metadata changes update validated metadata without re-alert. Keep observations until address removal. Never present an old observation as a newly discovered breach.
- Include HIBP attribution. Do not log address, digest, API key or raw provider response.

### Member surface and tool integration

- Members can ask via the chat tool and view a status line in Settings. Its input schema is empty: it derives the subject from the session and accepts no tenant, user, address selector, or free-form text. The tool reports persisted latest successful check, clean/breached/stale/never-checked/failed status truthfully; a successful check older than 8 days is stale (weekly cadence plus one-day grace). It does not make an on-demand provider request.
- Implement `lookupBreachedAccount` in `apps/web/lib/server/`, not `@neo/tools` (reserved for analyzers). Register the tool through `createToolRegistry` in `apps/web/lib/server/agent-run.ts`; existing `wrapToolResult` applies to every tool result.
- No user-supplied or HIBP content enters model context except through `wrapToolResult`.
- Update privacy notice during implementation to disclose HIBP, purpose, cadence and deletion behavior.

## Edge cases and acceptance criteria

- Verification requires browser session; 256-bit tokens are hashed, expire in 24h, single-use, address/user/tenant-bound; 3 sends per address/day and max 5 extra addresses/user are enforced.
- `emailVerified != null` is eligible; Auth.js successful sign-in syncs the verified primary address. Unset `NEO_MASTER_KEY` fails closed. No plain SHA or plaintext address storage.
- Stored uniqueness uses the tenant-scoped digest; the 3/day verification cap is keyed by that tenant digest, never the cross-household global coordination digest. The global digest is only an in-process grouping key and does not replace household ownership. `Retry-After` never exceeds one hour; `HIBP_RPM` defaults to 10 and User-Agent has its own env var.
- Request uses `truncateResponse=false&IncludeUnverified=false`. Owner alert email title/body contains breach name only and no address; owner alerts email owners only, member alerts remain in member feed; members have chat and Settings status surfaces.
- Tables, columns, indexes, FKs, tenant RLS/registry/grants and cascades match above. Leaving/removal deletes address and observations through `household.ts`; retired observations remain while address remains and do not re-alert.
- Mock mode makes no network calls. Tests cover crypto, verification, limits, global throttle, HIBP response classes, full response handling, dedupe, deletion, retired/metadata updates, tool wrapping, alert visibility and mock stores.

## Testing Guidelines

- Verify/extra-address lifecycle, token hashing/expiry/single use/binding, rate caps and fail-closed key handling.
- HIBP URL/query/headers including `truncateResponse=false`, 200/empty/404, 400/401/403/429/5xx, invalid response and mock behavior.
- Global digest throttle across tenants, configured RPM, retry cap, concurrent idempotency, retired breach and metadata-change behavior.
- PGlite as `app_user`: tenant RLS, unique indexes, FK cascades, address hard deletion through household hooks and grants.
- Tool registration and `wrapToolResult`; owner alert email title/body privacy, member feed visibility and Settings/chat status.

## Verified before implementation (2026-10-05)

Rechecked the official HIBP API v3 documentation on 2026-10-05.[1]

- Breached-account lookup uses `GET https://haveibeenpwned.com/api/v3/breachedaccount/{email}`. URL-encode the full address as one path segment, send `hibp-api-key`, and include a descriptive `User-Agent`; the endpoint requires an API subscription.[1]
- `truncateResponse=false` returns the full breach model, including `DataClasses`, needed for severity decisions. A `200` is a successful result and `404` means no matching breach was found.[1]
- `400` indicates invalid address input; `401`/`403` indicate key, authorization, or required-header problems; `429` is rate limited and supplies `Retry-After` seconds; `503` indicates service unavailability.[1]
- Subscription RPM depends on the owner's plan; retain configurable `HIBP_RPM` with a conservative default of 10 and confirm the actual plan before live use.[1]
- HIBP requires attribution under Creative Commons Attribution 4.0; include attribution in the member-facing status surface.[1]

## Implementation notes (as built, 2026-10-05)

- Migrations `0013_breach_monitoring` and `0014_breach_send_times` are additive after weekly-digest 0012. Migration 0014 replaces the initial counter/window with `verification_send_times`, a `timestamptz[]` column that stores the last three sends inside an exact rolling 24-hour window per tenant digest, shared across household members and app instances.
- Auth.js successful sign-in synchronizes the primary address only when `users.emailVerified` is non-null. The browser DELETE endpoint removes extra addresses only; the primary sign-in address is reconciled from the account and cannot be removed individually. Household leave/removal deletes all rows and observations.
- `stale` is derived when the last successful check is more than eight days old (weekly cadence plus a one-day grace). Status reads and the chat tool use persisted state only; they never call HIBP.
- Weekly Inngest dispatch groups equal global digests across households. The digest is used only for in-process grouping and single-flight; the weekly cron discovers, builds and sends events inside one `step.run` returning only a count, and persisted event payloads contain target identifiers and retry attempt only. Retries are new function runs, so the function-wide throttle applies to each attempt. `Retry-After` is capped at one hour. The daily sweeper uses database time and clears up to 1,000 expired verification hashes per batch.

## Sources

[1] https://haveibeenpwned.com/API/v3 — Have I Been Pwned API Documentation (v3)
