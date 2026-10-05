# Spec for weekly-digest

branch: hermes/feature/weekly-digest
plan: `_plans/deferred-roadmap-items.md` (step 1)

Owner-approved; step 1 implementation is underway on this branch. The migration is `0012_weekly_digest.sql`.

## Summary

Send an opted-in user a deterministic weekly email with their own security activity. Owners may additionally receive household-level alert counts and aggregate member-device health; they never receive member verdict details. Member digests contain no household-wide activity. The UTC weekly window is `[scheduled_at - 7 days, scheduled_at)` for Monday 14:00 UTC.

## Verified before implementation (2026-10-05)

- Resend's current Send Email docs confirm that custom `headers` are part of the JSON request body and `Idempotency-Key` is an HTTP request header. Its idempotency keys are limited to 256 characters and retained for 24 hours.[1][6] The docs do not establish DKIM coverage of custom unsubscribe headers; do not claim verified RFC 8058 compliance or DKIM behavior without checking delivered mail.
- RFC 8058 specifies HTTPS `List-Unsubscribe`, `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, DKIM coverage of both headers, a non-mutating GET and a non-redirecting POST.[2]
- Current Inngest TypeScript v4 docs confirm timezone-prefixed cron expressions and a unique `runId` per function run.[3][4]
- Durable `step.run` retries and `step.sendEvent` fan-out are documented.[5][8]
- A cron-triggered function has no `event` argument, and the docs do not establish a scheduled-occurrence timestamp at `event.ts`; therefore freeze the receipt time inside the first durable step and test its fallback.[4][7][9]
- This digest's send payload must not be stored in Inngest event or step state; retries instead reuse encrypted bytes in the tenant-scoped `digest_deliveries` row. No personal address or rendered body is returned from the prepare step.

## Functional requirements

### Consent and tenancy

- Store `weekly_digest_enabled` on each membership. Default owners on and members off; creation and role changes set the role-appropriate value explicitly. A role change resets the preference to the new role default. Users may change only their own setting; owners cannot inspect or change member preferences. The digest toggle is separate from alert-email threshold.
- Name the Settings page (`/settings/digest`) and API: `GET|POST /api/settings/digest`; a user changes their own preference only.
- At discovery and immediately before content selection/send, re-resolve current membership, role, verified deliverable email and preference. Fan-out carries both tenant and user IDs. Tenant data queries use `tenantScoped(db, tenantId)` and user filters. A stale event after leaving/moving cannot read or send former-household content.
- Recipient discovery uses a narrowly scoped SECURITY DEFINER function modelled on `list_stale_devices`, returning only `(tenant_id, user_id)` pairs. It is cursor-paginated with `LIMIT 1000`; revoke EXECUTE from PUBLIC and grant it to `app_user`. Discovery batches are at most 1,000 and subject to a global concurrency limit. It does not enumerate addresses or content, and there are no SECURITY DEFINER delivery-ledger claim/transition routines. A caller may only process a pair after re-resolving the current membership and preference under that tenant's RLS context.

### Reportable content and privacy

- Only alerts with `medium`, `high` or `critical` severity are reportable. `member_joined` and `device_enrolled` alone do not qualify. Use generic safe alert labels only—no member/device names or free-form alert titles—and link to existing verdict/household dashboard destinations; no new permission is introduced.
- Personal verdict counts include all four shared labels when at least one personal verdict exists: `malicious`, `suspicious`, `likely_safe`, `insufficient_evidence`. Up to three top verdicts sort by shared label rank, creation time descending, stable ID. Show sanitized dashboard-visible headline, label/date and same-origin `/verdicts/<id>` link only.
- Owner-only alert summaries count eligible member alerts by severity and show up to three generic labels, severity and date. Exclude `member_joined` and `device_enrolled` unless another qualifying reportable event exists. Do not double-count `device_offline` alerts and current device health: `device_offline` contributes only to current offline health, while other qualifying alerts count in alert summaries. `device_removed` counts as removed/uninstalled and is reportable. Do not expose member-by-member counts or alert bodies.
- Owner-only device health is aggregate current offline active devices of current household members; do not count owner devices or list names. If the reportable offline issue is already represented as `device_offline` alert, count it once in the health section, not both places. No healthy total or empty section.
- Skip when there is no reportable data. `member_joined`/`device_enrolled` alone, a healthy device, or household activity alone for a member does not trigger a message. Later breach-status and hardening-score renderer slots are omitted until their source feature exists and returns data.
- Subject is fixed and generic. No email/message bodies, checked URLs, IOCs, addresses, member/device names or free-form alert text in content, custom headers, tags or analytics. Escape/truncate all dynamic text and redact URLs, email addresses, phone-like runs of at least seven digits, and long alphanumeric tokens from verdict headlines, falling back to a generic label. Links reuse existing dashboard destinations and require normal authorization.

### Schedule and delivery

- Register cron `TZ=UTC 0 14 * * 1`. Current Inngest v4 cron handlers receive no `event` argument, so freeze the first execution's receipt timestamp (`new Date()` inside the first durable `step.run("digest-period", ...)`), snapped to the most recent Monday 14:00 UTC and memoized; never use `event.ts` or a run ID as a timestamp and never recalculate on retries. Fan out via `step.sendEvent` in batches of at most 1,000, with global concurrency limit and per-user concurrency key.
- Privacy decision (owner review): serialize the exact Resend request with role and delivery creation time, encrypt it using `deriveKey(master, "neo-weekly-digest-payload-v1", tenantId)` and AAD `digest:<tenantId>:<userId>:<isoWeek>`, and store only ciphertext in `digest_deliveries.payload`. Inngest event and step state contain no address, unsubscribe token, HTML, or text; the prepare-step result is only status and `deliveryCreatedAt`. Deployed preparation fails closed if `NEO_MASTER_KEY` is missing or invalid; local/mock uses a development-only key.
- Use one tenant-scoped `digest_deliveries` row per user/week with unique `(user_id, iso_week)`. `savePayload`/`getPayload` require the current tenant, user, week, run ID, and `sending` state; save is insert-once so a takeover reuses the exact same ciphertext and provider request. Terminal states clear ciphertext. The daily artifacts-expire job clears payloads on non-sending rows and sending rows older than 24 hours; because it runs daily, a sending payload may remain roughly 24–48 hours from creation under the normal schedule. A retry with the same Inngest run ID may resume its row regardless of claim age; a different run may take over only after `claimed_at` is at least 15 minutes old. Keep `created_at` for the original delivery and reuse the same Resend key `digest:<userId>:<ISO week>` (ISO week form `YYYY-Www`). If an unresolved provider outcome outlasts Resend's documented 24-hour key retention, do not automatically resend.[1][6] Resend 408/409/429 are retryable (without terminalizing the ledger); other 4xx mark `failed`; 5xx is retried. Throttle digest sends to 2 requests/second.
- If a user moves households during an ISO week and the global `(user_id, iso_week)` uniqueness collides with a row hidden by tenant RLS, do not read or mutate the former tenant's row; suppress the new tenant's duplicate delivery for that week and resume next week. Log the collision only: do not persist `suppressed`, because the uniqueness constraint prevents inserting the duplicate row. This intentionally favors tenant isolation over a user-owned cross-tenant delivery ledger.
- Empty periods are recorded without email. Re-check consent and live membership before sending. Changes after provider acceptance cannot recall mail.

### Unsubscribe and settings

- Use versioned `v1.` purpose-bound HMAC token derived from `AUTH_SECRET`, no email/name in token, constant-time verification. Missing production secret fails closed; mock development may use a documented dev key.
- Routes: `GET` and `POST /api/digest/unsubscribe`. GET is read-only and scanner-safe; POST is idempotent, immediate and changes only the token owner's preference; do not redirect. Validate the HMAC before applying a 10 requests/hour/IP limiter, and rate-limit only malformed or invalid-HMAC requests on either method; valid tokens must not be blocked because several household members share an IP. Use no-store/no-referrer and never log token/full URL. Include HTTPS `List-Unsubscribe` and `List-Unsubscribe-Post` headers, but do not claim DKIM coverage or RFC 8058 compliance until delivered-message verification.
- The same preference is controlled at `/settings/digest` via `GET|POST /api/settings/digest`.

### Persistence and mock mode

- Add additive migration `0012_weekly_digest.sql`. `digest_deliveries` is tenant-scoped, registered in `tenantTables`, has `tenant_isolation` RLS, and an explicit `app_user` grant. `payload bytea` stores only AES-GCM ciphertext; the migration's recipient-discovery `EXECUTE` grant is exercised by PGlite without a test-added grant. There are no SECURITY DEFINER delivery-ledger claim/transition functions; the narrowly scoped recipient-discovery function is specified above.
- In mock mode, use in-memory preference, delivery and encrypted-payload stores plus in-memory recipient/content stores and mock mailer. Match database semantics for unique user/week delivery, owner/run checks, retry takeovers, terminal clearing, a 24-hour age cutoff, and daily cleanup cadence. A mock digest sent to `http://localhost` in non-deployed mode must appear in `memorySentEmails()`; deployed rendering requires HTTPS.
- `OutgoingEmail` has optional `headers?: Record<string, string>`; send them in the Resend request body and retain them in mock `SentEmail` records. Resend HTTP failures throw typed `MailerHttpError { status: number }`: 408/409/429 retry without marking the ledger failed, other 4xx are terminal, and 5xx retries. Throttle digest sends to 2 requests/second.
- Update privacy page and test during implementation. No DKIM coverage guarantee absent direct verification.

## Edge cases and acceptance criteria

- A role change resets preference; moved/removed membership cannot expose prior-tenant content.
- A mid-week household move never reads or mutates the prior tenant's delivery row; a global unique-key collision suppresses that week's duplicate.
- A DB payload round-trips under the tenant-derived key/AAD, fails under the wrong AAD, is unreadable across tenants under `app_user`, is absent from delivery DTOs, and clears on terminal state and the 24-hour age cutoff under the daily sweep. A deployed environment without `NEO_MASTER_KEY` cannot prepare or send.
- Inngest prepare-step output contains only status and creation time; retries under a new run ID reuse the byte-identical stored provider request. A role change between prepare and send prevents delivery.
- Resend 408/409/429 retry without marking failed; other 4xx fail terminally and 5xx retry. Digest sends are limited to 2 requests/second.
- `member_joined` and `device_enrolled` alone never produce a digest; only medium+ alerts count; device-offline alert and health do not double-count; removed/uninstalled is reportable.
- Discovery is paginated, batches never exceed 1,000, global concurrency is bounded, and unverified/opted-out/member-default recipients are excluded using the migration-granted function.
- Valid unsubscribe tokens succeed even when callers share an IP; only malformed and invalid-HMAC GET/POST requests consume the per-IP limit.
- A non-deployed `http://localhost` mock send lands in `memorySentEmails()`; production URLs remain HTTPS-only.
- Content uses `periodEnd` for the 48-hour offline threshold regardless of wall-clock time. Headlines redact seven-plus digit runs and long alphanumeric tokens; rendering escapes quotes/ampersands and rejects javascript links.
- Cron runtime test confirms the current Inngest v4 handler has no event argument; unit tests cover an absent or misaligned optional event timestamp falling back to the durable receipt-time boundary.
- PGlite data-test setup uses `beforeAll(..., 60_000)`, `afterAll` cleanup, and an explicit per-test timeout.
- `AUTH_SECRET` rotation invalidates previously issued unsubscribe links; this is disclosed on the privacy page.

## Testing Guidelines

- `apps/web/test/weekly-digest*.test.ts`: role-specific content, reportability, offline dedupe, preferences and role reset, pagination/batch/concurrency, provider retries/statuses, unsubscribe, templates and in-memory stores.
- `packages/db/test/weekly-digest.test.ts` (PGlite as `app_user`): tenant isolation, membership preference defaults/reset, unique `(user_id, iso_week)`, retrying the owning `sending` delivery.
- Runtime Inngest test confirms the cron handler has no event argument; helper tests cover absent and misaligned timestamps and memoized receipt-time fallback.

## Sources

[1] https://resend.com/docs/api-reference/emails/send-email
[2] https://www.rfc-editor.org/rfc/rfc8058
[3] https://www.inngest.com/docs/guides/scheduled-functions
[4] https://www.inngest.com/docs/reference/typescript/v4/functions/create
[5] https://www.inngest.com/docs/reference/typescript/v4/functions/step-run
[6] https://resend.com/docs/dashboard/emails/idempotency-keys
[7] https://www.inngest.com/docs/durable-execution/guides-and-advanced/events-and-triggers/schedules-and-delayed-starts
[8] https://www.inngest.com/docs/reference/typescript/v4/functions/step-send-event
[9] https://www.inngest.com/docs/durable-execution/primitives/event-and-trigger-concepts
