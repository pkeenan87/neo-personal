# Spec for weekly-digest

branch: hermes/feature/weekly-digest
plan: `_plans/deferred-roadmap-items.md` (step 1)

Documentation-only proposal; do not implement before owner approval. The migration is the **next free number at implementation time**.

## Summary

Send an opted-in user a deterministic weekly email with their own security activity. Owners may additionally receive household-level alert counts and aggregate member-device health; they never receive member verdict details. Member digests contain no household-wide activity. The UTC weekly window is `[scheduled_at - 7 days, scheduled_at)` for Monday 14:00 UTC.

## Verified before implementation (2026-10-04)

- Resend accepts custom `headers` in the Send Email JSON body and an `Idempotency-Key` request header; documented idempotency retention is 24 hours.[1][6] Its docs do not establish DKIM coverage of custom unsubscribe headers; do not claim verified RFC 8058 compliance or DKIM behavior without checking delivered mail.
- RFC 8058 specifies HTTPS `List-Unsubscribe`, `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, DKIM coverage of both headers, a non-mutating GET and a non-redirecting POST.[2]
- Inngest documents cron timezone and durable step retries/fan-out.[3][5][8] Its current TypeScript v4 cron-handler documentation and event-trigger documentation do not establish that `event.ts` is the scheduled occurrence boundary.[4][9] Verify `ts` at runtime during implementation; use a stable fallback if absent, never guess from wall clock/run ID.

## Functional requirements

### Consent and tenancy

- Store `weekly_digest_enabled` on each membership. Default owners on and members off; creation and role changes set the role-appropriate value explicitly. A role change resets the preference to the new role default. Users may change only their own setting; owners cannot inspect or change member preferences. The digest toggle is separate from alert-email threshold.
- Name the Settings page (`/settings/digest`) and API: `GET|POST /api/settings/digest`; a user changes their own preference only.
- At discovery and immediately before content selection/send, re-resolve current membership, role, verified deliverable email and preference. Fan-out carries both tenant and user IDs. Tenant data queries use `tenantScoped(db, tenantId)` and user filters. A stale event after leaving/moving cannot read or send former-household content.
- Discovery is paginated, at most 1,000 recipients per batch, and subject to a global concurrency limit. Do not introduce cross-tenant user enumeration or SECURITY DEFINER delivery-ledger routines.

### Reportable content and privacy

- Only alerts with `medium`, `high` or `critical` severity are reportable. `member_joined` and `device_enrolled` alone do not qualify. Use generic safe alert labels only—no member/device names or free-form alert titles—and link to existing verdict/household dashboard destinations; no new permission is introduced.
- Personal verdict counts include all four shared labels when at least one personal verdict exists: `malicious`, `suspicious`, `likely_safe`, `insufficient_evidence`. Up to three top verdicts sort by shared label rank, creation time descending, stable ID. Show sanitized dashboard-visible headline, label/date and same-origin `/verdicts/<id>` link only.
- Owner-only alert summaries count eligible member alerts by severity and show up to three generic labels, severity and date. Exclude `member_joined` and `device_enrolled` unless another qualifying reportable event exists. Do not double-count `device_offline` alerts and current device health: `device_offline` contributes only to current offline health, while other qualifying alerts count in alert summaries. `device_removed` counts as removed/uninstalled and is reportable. Do not expose member-by-member counts or alert bodies.
- Owner-only device health is aggregate current offline active devices of current household members; do not count owner devices or list names. If the reportable offline issue is already represented as `device_offline` alert, count it once in the health section, not both places. No healthy total or empty section.
- Skip when there is no reportable data. `member_joined`/`device_enrolled` alone, a healthy device, or household activity alone for a member does not trigger a message. Later breach-status and hardening-score renderer slots are omitted until their source feature exists and returns data.
- Subject is fixed and generic. No email/message bodies, checked URLs, IOCs, addresses, member/device names or free-form alert text in content, custom headers, tags or analytics. Escape/truncate all dynamic text and redact URLs/emails from verdict headlines, falling back to a generic label. Links reuse existing dashboard destinations and require normal authorization.

### Schedule and delivery

- Register cron `TZ=UTC 0 14 * * 1`. Verify `event.ts` at runtime as the scheduled occurrence timestamp; freeze the period in a durable first Inngest step. If `event.ts` is absent or not that boundary, the named fallback is the first execution's receipt timestamp (`new Date()` inside the first durable `step.run("digest-period", ...)`), snapped to the most recent Monday 14:00 UTC and memoized; never recalculate it on retries. Fan out via `step.sendEvent` in batches of at most 1,000, with global concurrency limit and per-user concurrency key.
- Use one tenant-scoped `digest_deliveries` row per user/week with unique `(user_id, iso_week)` and no user-owned/cross-tenant ledger. Include minimal status/timestamps/provider ID; no content or recipient address. Use `Resend Idempotency-Key: digest:<userId>:<ISO week>` (ISO week form `YYYY-Www`) plus Inngest step retries. A retry finding its own `sending` row must resume/retry the identical provider request with that same key, not drop the email; concurrent distinct runs must not send another request while the owning execution is live. If an unresolved provider outcome outlasts the documented 24-hour key retention, do not automatically resend. Persist terminal `sent`, `empty`, `suppressed` or `failed` states. Resend 4xx marks `failed` and is not retried; 5xx is retried. Do not claim provider idempotency lasts beyond its documented 24 hours.
- If a user moves households during an ISO week and the global `(user_id, iso_week)` uniqueness collides with a row hidden by tenant RLS, do not read or mutate the former tenant's row; suppress the new tenant's duplicate delivery for that week and resume next week. This intentionally favors tenant isolation over a user-owned cross-tenant delivery ledger.
- Empty periods are recorded without email. Re-check consent and live membership before sending. Changes after provider acceptance cannot recall mail.

### Unsubscribe and settings

- Use versioned `v1.` purpose-bound HMAC token derived from `AUTH_SECRET`, no email/name in token, constant-time verification. Missing production secret fails closed; mock development may use a documented dev key.
- Routes: `GET` and `POST /api/digest/unsubscribe`. GET is read-only and scanner-safe; POST is idempotent, immediate and changes only the token owner's preference; do not redirect. Rate limit 10 requests/hour/IP. Use no-store/no-referrer and never log token/full URL. Include HTTPS `List-Unsubscribe` and `List-Unsubscribe-Post` headers, but do not claim DKIM coverage or RFC 8058 compliance until delivered-message verification.
- The same preference is controlled at `/settings/digest` via `GET|POST /api/settings/digest`.

### Persistence and mock mode

- Add an additive migration at the next free number at implementation time. `digest_deliveries` is tenant-scoped, registered in `tenantTables`, has `tenant_isolation` RLS, and an explicit `app_user` grant (or document that default privileges in `create-app-user.sql` cover it). Unique `(user_id, iso_week)`; all access is tenant-scoped. No SECURITY DEFINER claim/transition functions.
- In mock mode, use in-memory preference and delivery stores plus the in-memory recipient/content stores and mock mailer; these stores must match database semantics for unique user/week delivery and resumable retries. Mailer gains optional `headers`, retained in mock sent-email records.
- Update privacy page and test during implementation. No DKIM coverage guarantee absent direct verification.

## Edge cases and acceptance criteria

- A role change resets preference; moved/removed membership cannot expose prior-tenant content.
- A mid-week household move never reads or mutates the prior tenant's delivery row; a global unique-key collision suppresses that week's duplicate.
- A retried Inngest step that owns a `sending` delivery retries with the identical Resend key; Resend 4xx is terminal/non-retryable and 5xx retries.
- `member_joined` and `device_enrolled` alone never produce a digest; only medium+ alerts count; device-offline alert and health do not double-count; removed/uninstalled is reportable.
- Discovery is paginated, batches never exceed 1,000, and global concurrency is bounded.
- Unsubscribe token starts `v1.`, GET does not mutate, POST is idempotent, and 10/hour/IP is enforced.
- Cron boundary runtime check and fallback are specified; no future verification date is used.
- Tests cover role/content isolation, preference reset, empty weeks, alert threshold/kinds, device deduplication, retry ownership, provider 4xx/5xx behavior, pagination/concurrency, unsubscribe and mock stores.

## Testing Guidelines

- `apps/web/test/weekly-digest*.test.ts`: role-specific content, reportability, offline dedupe, preferences and role reset, pagination/batch/concurrency, provider retries/statuses, unsubscribe, templates and in-memory stores.
- `packages/db/test/weekly-digest.test.ts` (PGlite as `app_user`): tenant isolation, membership preference defaults/reset, unique `(user_id, iso_week)`, retrying the owning `sending` delivery.
- Runtime Inngest test verifies `event.ts` occurrence semantics; tests stable fallback if absent.

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
