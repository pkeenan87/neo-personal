# Spec for Forward-to-address (inbound email, triage, notification)

branch: claude/feature/forward-to-address

## Summary

Every household gets an address like `check-k7m2p9x4qz3w@inbound.<domain>`. Members forward a suspicious email to it from any mail provider. Resend receives it and calls our webhook; an Inngest job fetches the raw message, stores it as an artifact, runs `analyzeEmail`, asks Sonnet 5 for a structured `Verdict`, stores the verdict, and emails the forwarder a short result with a link. No OAuth, works with Gmail, iCloud, Outlook.com, Yahoo, and everything else.

Threat model: the inbound address is public once used; anyone can send to it. Only mail whose recipient is an active address is processed; the notification goes only to a **member** of that household (matched by verified email), never to the envelope sender.

## Functional requirements

### Data (`@neo/db`, migration `0003_phase1`)

```sql
inbound_addresses (id uuid pk, tenant_id uuid fk, local_part text unique not null, active boolean not null default true, created_at, rotated_at, last_used_at)
-- verdicts: add source text not null default 'chat' check (source in ('chat','inbound','api')), artifact_id uuid null fk artifacts(id) on delete set null,
--           conversation_id stays nullable; add index (tenant_id, source, created_at desc)
inbound_messages (id uuid pk, tenant_id uuid fk, address_id uuid fk, provider_message_id text unique not null, from_address_hash text not null, forwarder_user_id text null fk users(id), artifact_id uuid null, verdict_id uuid null, status text not null check (status in ('received','analyzing','done','rejected','over_cap','failed')), error text null, received_at, completed_at)
```
RLS on both new tables keyed on `tenant_id`. Helpers:
```ts
export const inbound: {
  ensureAddress(db, tenantId): Promise<{ id; localPart; address }>;                 // creates on first call; address needs NEO_INBOUND_DOMAIN
  rotateAddress(db, tenantId): Promise<{ id; localPart }>;                          // deactivates the old one
  findActiveByLocalPart(db, localPart): Promise<{ id; tenantId } | undefined>;      // NOT tenant-scoped (lookup before we know the tenant); owner-role safe: the webhook route uses it, then everything else is tenant-scoped
  recordMessage(db, input): Promise<{ id }>; updateMessage(db, id, tenantId, patch): Promise<void>;
  countRecent(db, addressId, windowMs): Promise<number>;                           // rate limit
};
export function generateLocalPart(): string;  // "check-" + 12 chars from Crockford base32 lowercase, crypto random
```
Note on RLS: the app role's `findActiveByLocalPart` needs a policy on `inbound_addresses` that permits `select` where `active` is true for any tenant **or** a security-definer function. Use a `security definer` SQL function `resolve_inbound_address(local_part text) returns table(id uuid, tenant_id uuid)` owned by the migration role; document in `packages/db/docs/rls.md`.

### Webhook `POST /api/inbound/resend` (`apps/web`)

- Verify the Svix signature (`svix-id`, `svix-timestamp`, `svix-signature`) with `RESEND_WEBHOOK_SECRET` (`svix` package `Webhook.verify`). 401 on failure; 200 `{ ignored: true }` for event types other than `email.received`; 503 when the secret is unset (unless `MOCK_MODE`, where an `x-neo-mock-inbound: 1` header from localhost is accepted for local testing).
- Payload gives `email_id`, `from`, `to[]`, `subject`, `message_id`. Resolve the first recipient local part that matches an active address (`resolve_inbound_address`); none → 200 `{ ignored: true }` (never 4xx, so Resend does not retry and senders learn nothing).
- Idempotency: `provider_message_id` unique; a duplicate → 200.
- Rate limit: > 30 messages for the address in the last hour → record `rejected`, 200.
- Insert `inbound_messages` row `received`, then `inngest.send({ name: "neo/email.received", data: { inboundMessageId, tenantId } })`. In `MOCK_MODE` without `INNGEST_EVENT_KEY`, run the job function inline (awaited) so local tests are end to end.
- Respond within 5 s; all work is in the job.

### Job `email/received` (Inngest function, `apps/web/inngest/functions/email-received.ts`)

Steps (each an `step.run` so retries resume):
1. `fetch-raw`: `GET https://api.resend.com/emails/receiving/{email_id}/raw` (or the Resend SDK equivalent; verify against current Resend docs when implementing) using `AUTH_RESEND_KEY` (same key as magic links; name it `RESEND_API_KEY` alias in env.ts: `RESEND_API_KEY ?? AUTH_RESEND_KEY`). Size cap 2 MB; over → status `failed` with `too_large`, notify.
2. `store-artifact`: `ArtifactStore.put` kind `inbound_eml`, source `inbound`.
3. `identify-forwarder`: parse the outer message; the envelope `from` (or `Resent-From`) must match a member's verified email in the tenant (case-insensitive, no plus-address stripping in Phase 1); store `forwarder_user_id`. Unknown forwarder → status `rejected`, artifact purged immediately, no notification, audit event `inbound.rejected_unknown_sender`.
4. `check-caps`: `usage.checkCaps`; over → verdict row `insufficient_evidence` with headline "Not analyzed: your household reached its monthly limit" and `source: 'inbound'`, status `over_cap`, notify with the reset date.
5. `analyze`: `analyzeEmail({ raw })` with `maxUrls: 6`.
6. `triage`: `runTriage` (below) → `Verdict`; save with `source: 'inbound'`, `artifact_id`, `user_id = forwarder_user_id`; `usage.recordCheck` with the triage model and `kind: "check"`.
7. `notify`: send the result email via Resend to the forwarder; store `completed_at`, status `done`.
Retries: 3, backoff default. Concurrency: `{ limit: 5, key: "event.data.tenantId" }`. Timeout 4 minutes. On final failure: status `failed`, notify "we could not analyze this message".

### Triage helper (`@neo/core`)

```ts
export async function runTriage(input: { evidence: unknown; evidenceKind: "email" | "sms"; guidance: string; client?: Anthropic; model?: string; signal?: AbortSignal }): Promise<{ verdict: Verdict; usage: AgentUsage; model: string }>;
```
- One non-streaming `messages.create` on `NEO_TRIAGE_MODEL` (default `claude-sonnet-5`), `output_config: { effort: "low", format: { type: "json_schema", schema: verdictJsonSchema } }` (verify the exact structured-output shape in the claude-api skill TypeScript README before coding; use the beta namespace if required), `max_tokens: 2048`, system = `TRIAGE_SYSTEM_PROMPT` (short: same untrusted-content rules as chat, "return only the verdict"), the evidence wrapped with `wrapToolResult("analyze_email", evidence, {})` in the user message. Validate with `VerdictSchema`; on parse failure retry once at `effort: "medium"`, then return an `insufficient_evidence` verdict with indicator `triage_failed`.
- `MOCK_MODE`: a scripted client returns a deterministic verdict derived from `heuristics` (any `*_fail`, `lookalike_*`, `dangerous_*` → malicious/suspicious).

### Notification email

- Template (React Email is not required; a small HTML+text template function `renderVerdictEmail(verdict, { detailUrl, forwardedSubject })` in `apps/web/lib/server/email/`): subject `Neo: <verdict label> — "<forwarded subject truncated 60>"`, body with headline, label chip, top 3 indicators (evidence quoted, ≤ 200 chars each, HTML-escaped), actions, link to `/verdicts/<id>`, footer "Reply to this email does nothing; ask Neo in the app".
- From `EMAIL_FROM`. Sent through `resend.emails.send` with idempotency key `verdict-<id>`. No untrusted HTML from the analyzed message is ever included (only escaped text).

### Retention cron `artifacts/expire`

Inngest cron `0 4 * * *`: `listExpired(200)` → `purge` each; log counts. Also purges `inbound_messages` older than 90 days with status `rejected`/`failed`.

### Settings page `/settings/forwarding`

- Shows the household address with copy button, "Rotate address" (confirm dialog; old address stops working immediately), and per-provider guides as tabs: Gmail (filter with "Forward it to" — requires verifying the forwarding address, so explain the confirmation email Gmail sends to the Neo address; the job must detect Gmail's confirmation mail, extract the confirmation link and code, and surface it to the tenant owner on the settings page as "Gmail is asking to confirm forwarding: code XXXX" without visiting the link), iCloud (Mail rules: "Forward to"), Outlook.com (Rules → Forward), Yahoo (forward individually; auto-forward is paid), plus "Forward as attachment" instructions for one-off checks.
- Lists the last 20 inbound messages (status, subject if available, link to the verdict).

### Env (add to `.env.example`, code works when unset)

`NEO_INBOUND_DOMAIN`, `RESEND_WEBHOOK_SECRET`, `RESEND_API_KEY` (optional alias), `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`, `NEO_TRIAGE_MODEL` (already listed), `NEO_INBOUND_RATE_LIMIT_PER_HOUR` (default 30), `BLOB_READ_WRITE_TOKEN`, `NEO_MASTER_KEY`, `NEO_ARTIFACT_RETENTION_DAYS` (default 30).

## Possible Edge Cases

- Gmail forwarding-verification email arrives first (from `forwarding-noreply@google.com`): handled as above; not analyzed as phishing (but the guides warn that real phish imitate this mail, so the page shows only the code, and the user enters it in Gmail).
- Forward from an alias not on the account (`me+neo@gmail.com`): rejected; the settings page lists member emails that are accepted and links to "add an alias" (Phase 2).
- The user forwards a benign newsletter daily: caps apply; the notification includes usage remaining when under 20%.
- Attachment-only forward (`.eml` attached, empty body): the analyzer's forward-wrapper detection analyzes the inner message.
- Two members forward the same phish: two verdicts, both notified; dedupe by inner `Message-ID` is a Phase 2 nicety.
- Resend retries the webhook after our 200 was slow: idempotency by `provider_message_id`.
- Job runs but Blob is unconfigured: `failed` with `storage_unavailable`; notify.
- Very large HTML mail above 2 MB raw: `failed` `too_large`; notify with the paste/upload alternative.

## Acceptance Criteria

- Webhook: bad signature 401; unknown recipient 200 ignored; duplicate 200; valid → row + event.
- Job in MOCK_MODE end to end (inline): fixture raw email → artifact stored → verdict `source: 'inbound'` → notification rendered (captured by a mock Resend client) → status `done`.
- Unknown forwarder → rejected, artifact purged, no email.
- Over cap → `over_cap` verdict and notification mention the reset date; no model call.
- Address rotation invalidates the old address on the next webhook.
- Retention job purges expired artifacts and leaves fresh ones.

## Open Questions

- Resend inbound raw-fetch endpoint name and whether the webhook payload already includes headers; the implementing agent verifies against Resend's current docs and records the answer in the spec.
  **Verified 2026-09-25 (resend.com/docs):** the `email.received` webhook carries metadata only (`data.email_id`, `from`, `to[]`, `subject`, `message_id`, `received_for`, attachment metadata); no body or headers. There is no `/raw` endpoint: `GET https://api.resend.com/emails/receiving/{email_id}` (SDK `resend.emails.receiving.get(id)`) returns `from`, `to`, `subject`, `headers` (map), `received_for[]`, `authentication { spf, dkim, dmarc }`, `message_id`, and `raw { download_url, expires_at }` (signed URL, about 1 h). The job fetches that, then downloads `download_url` (no auth header) with a streaming 2 MB cap. Webhook signatures are Svix (`svix-id`, `svix-timestamp`, `svix-signature`; `new Webhook(secret).verify(rawBody, headers)`, svix 2.5.0, which returns `undefined` and throws on failure). Sending: `POST /emails` with `Idempotency-Key` (≤ 256 chars, 24 h). Implemented with `fetch` rather than the `resend` SDK (the current SDK release was newer than the workspace's minimum release age).
  **Inngest (inngest 4.21.0):** `new Inngest({ id })` reads `INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY`; v4 is in cloud mode unless `INNGEST_DEV` is set. `createFunction({ id, triggers: [{ event }] | [{ cron }], retries, concurrency: { limit, key }, timeouts: { finish }, onFailure }, handler)`; `onFailure` receives `event.data.event` (the original event). `serve` from `inngest/next` returns `{ GET, POST, PUT }`.
- Step order vs. the forwarder: `store-artifact` runs before `identify-forwarder` (as specified), so the artifact is attributed to the household owner until the forwarder is known; unknown senders' artifacts are purged in `identify-forwarder`. Identification uses Resend's parsed headers: `Resent-From`, then `from` (skipped when Resend reports DMARC `fail`), then Gmail's `X-Forwarded-For`, then `Return-Path` (Gmail filter forwards use `user+caf_=…@gmail.com`; only that Gmail suffix is unwrapped). Recipient matching also uses `received_for`, because auto-forwards keep the original `To:`.
- Gmail confirmation codes are stored in `inbound_messages.error` as `gmail_confirmation:<digits>` (no schema change); the link is extracted but never visited or stored. The mail is recognized only from `forwarding-noreply@google.com` with DMARC (or DKIM) pass when Resend reports authentication.
- Rotation is owner-only (it breaks every member's forwarding rules). Members see the address and history but not the Gmail code.
- `inbound_messages` has no subject column, so the settings list shows status, time, reason and the verdict link, not the subject.
- Whether to accept forwards from any verified member email including plus-addresses. Phase 1: exact match only.

## Testing Guidelines
- `apps/web/test/inbound-webhook.test.ts`: signature verification (real svix test vectors), routing, idempotency, rate limit.
- `apps/web/test/email-received-job.test.ts`: the function's step logic with injected store/resend/model fakes, every status path.
- `apps/web/test/verdict-email.test.tsx`: template escaping, truncation, links.
- `packages/db/test/inbound.test.ts`: address generation, uniqueness, rotation, resolve function under the app role, RLS isolation.
- `packages/core/test/triage.test.ts`: structured output parsing, retry, fallback verdict, mock client.
