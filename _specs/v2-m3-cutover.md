# Spec for v2-m3-cutover

branch: claude/feature/v2-m3-cutover
plan: `_plans/v2.md` (M3); architecture: `_specs/v2-architecture.md` (§4, §5)
status: draft, 2026-11-03 (slice 1 built on `claude/feature/v2-m3-schedules`)

## Summary

M3 moves Neo's background work from Inngest to eve schedules and brings the eve chat to parity with the legacy `/api/agent` loop. It adds agent memory, a remote `end_session` tool, and the Twilio channel code (mock-only). The goal is a clean cutover where eve handles proactive and reactive work, with Inngest remaining as a fallback until the owner confirms parity.

## Functional requirements

### 1. Background work cutover (Slice 1)
Each job moves to an eve schedule (`apps/web/agent/schedules/<name>.ts`, `defineSchedule` with a `run` handler: no prompt, no model session, so no model cost; the handler never calls `to(...).send`). During the transition, the eve schedule runs in **shadow mode**: it computes everything and records what it *would* do, with no side effects. A flag `NEO_EVE_SCHEDULES` (comma-separated job names, default empty) controls which jobs are "live": for a listed job the eve schedule runs live and the Inngest function becomes a no-op; for every other job Inngest stays live and eve runs shadow. Unknown names are ignored with a warning. Inngest code is **not** deleted in M3; removal is a post-M3 owner-approved step.

Each job core takes an explicit `mode: "shadow" | "live"` and read-only ports; the write effects exist only in the live branch's input (type-level separation), and shadow gets a recorder. Both runners write one `schedule_runs` row per run (job-level, not tenant data): job, runner, mode, timing, outcome, counts, and a stable digest of the planned actions (sorted `(tenantId, kind, key)` triples, no addresses or message content), so the owner can compare `inngest` and `eve` per cycle (`compareScheduleRuns(job, since)`).

- **1a. `weekly-digest`** (cron `0 14 * * 1`, UTC): the planned actions are the digest sends (one per recipient and ISO week). Live sends through the same delivery code as Inngest.
- **1b. `devices-offline`** (hourly): the planned actions are the devices that would be marked offline. Live marks them and raises the alerts.
- **1c. `breach-monitoring`** (Mondays 15:00 UTC): the planned actions are the grouped address checks. Shadow makes no HIBP request and uses no token.
- **1d. `retention`** (daily 04:00 UTC, the `artifacts-expire` job): expired artifacts, rejected inbound rows, old alerts, devices, signals, reputation cache, digest payloads and expired child requests. Shadow lists the artifacts it would purge; the SQL purges are opaque and recorded by kind.
- **1e. `outbox-sweep`** (every 5 minutes): the planned actions are the tenants with a pending outbox. Live drains them.

**Acceptance Criteria:**
- Each eve schedule is implemented and unit-tested.
- Shadow runs are recorded in `schedule_runs` and queryable.
- The `NEO_EVE_SCHEDULES` flag is respected: jobs not in the list are shadow in eve and live in Inngest; jobs in the list are live in eve and no-ops in Inngest.
- Unset `NEO_EVE_SCHEDULES` changes nothing in production.
- No double-sends or double-deletes occur during the transition.

### 2. Eve chat parity (Slice 2)
The eve chat must handle the same user intents as the legacy `/api/agent` chat. The legacy chat and `/api/agent` remain live until the owner flips `NEO_EVE_CHAT=true` and confirms parity.

- **2a. Paste-a-link URL check**: User pastes a URL; eve calls `analyze_url` and returns a verdict card.
- **2b. Email/SMS paste**: User pastes an email or SMS body; eve calls `analyze_email` or `analyze_sms` and returns a verdict card.
- **2c. Playbooks**: User asks for a playbook (e.g., "What should I do if I get a scam call?"); eve returns the relevant playbook content.
- **2d. Verdict cards**: All analysis results are rendered as structured verdict cards (severity, evidence, recommended action).
- **2e. Sign-in alert "Was this you?"**: When a sign-in alert is created, the eve chat prompts the user with "Was this you?" and records the response.
- **2f. Model routing**: the eve chat follows the member's routing preference and model family (`packages/core/src/routing.ts`), with the same Haiku 4.5 restrictions, and records usage in `usage_events`.

**Acceptance Criteria:**
- Each intent is handled by the eve agent with the correct tools and prompts.
- Verdict cards are rendered consistently in the web chat UI.
- The "Was this you?" flow updates the alert status and logs the user's response.
- The legacy `/api/agent` is still functional and unchanged.

### 3. Agent memory (Slice 3)
The eve agent remembers household context scoped per tenant (for example "Grandma's helper is Patrick; her TeamViewer is expected"). Memory is a persistence channel for prompt injection, so writes are tightly limited:
- Entries are written only (a) by an owner in the console, or (b) by the `remember` tool, which is owner-only: it needs `always()` approval showing the exact text to store, plus a server-side owner check. The stored text must come from the owner's own chat turn, never from a tool result, email, SMS, page or child request.
- Entries reach the model only through `wrapToolResult` (`recall` tool), as evidence, never as instructions.

- **3a. Memory scope**: Memory is scoped to `tenant_id` and `principal_id` (user or member).
- **3b. What may be remembered**: short household facts (names, relationships, expected tools, preferences), ≤280 characters each, at most 100 per household. No contact details, credentials, or financial data (rejected by a server-side check).
- **3c. Retention**: Memory entries have a TTL (e.g., 90 days) and are purged by the retention schedule.
- **3d. Console view**: The admin console has a page to view and forget memory entries for a tenant.

**Acceptance Criteria:**
- Memory is stored in a `agent_memory` table with `tenant_id`, `principal_id`, `key`, `value`, `created_at`, `expires_at`.
- The eve agent reads memory with `recall` (read-only) and writes only with `remember` (owner-only, `always()` + server-side owner check); `forget` is console-only.
- The console page lists memory entries and allows deletion.
- Retention schedule purges expired memory entries.

### 4. `end_session` tool (Slice 4)
A new acting tool `end_session` allows the eve agent to end a remote session on a desktop agent.

- **4a. Approval**: The tool uses `always()` approval. The server re-checks that the approver is an admin.
- **4b. Elder autonomy**: If the target device belongs to an elder, the elder must confirm on screen before the session is ended. A helper alone cannot end the session without the elder's confirmation.
- **4c. Execution**: there is no command channel today. The command is delivered as a signed `commands` entry in the device's policy bundle (`{ id, kind: "end_session", sessionRef, requiresConfirmation, expiresAt }`), picked up through the existing fast poll (60 s while a command is pending). The device acks the result with a signal (`command_result`). Commands expire after 10 minutes.

**Acceptance Criteria:**
- The `end_session` tool is implemented and unit-tested.
- The approval flow is enforced: non-admins cannot approve, and the server re-checks the approver's role.
- For elder devices, the command is sent to the device with a `requires_confirmation: true` flag. The device displays a confirmation prompt, and the session is ended only if the elder confirms.
- The incident log records the request, approval, and confirmation.

### 5. Twilio SMS/voice channel (Slice 5)
Code for the Twilio SMS and voice channels is added behind a flag. No Twilio account or A2P registration is done in M3; the code is mock-only.

- **5a. Channel code**: Implement the Twilio channel in `apps/web/agent/channels/twilio.ts` (or similar). It handles inbound SMS/voice and outbound messages.
- **5b. Mock mode**: In mock mode, the channel logs messages instead of sending them.
- **5c. Flag**: The channel is enabled only if `NEO_TWILIO_ENABLED=true` and the Twilio credentials are set.

**Acceptance Criteria:**
- The Twilio channel code is implemented and unit-tested.
- In mock mode, messages are logged and not sent.
- The channel is disabled by default.

### 6. Per-household monthly model spend cap (Slice 6)
A cap on the monthly model spend per household is added. It is off by default. If enabled, an alert is sent to the owner when 80% of the cap is reached.

- **6a. Cap setting**: builds on the existing usage tracking (`usage_events` and the usage caps in `packages/db/src/usage.ts`, `_specs/usage-caps.md`): a nullable `monthly_spend_cap_cents` on the household (tenants), set by owners in settings.
- **6b. Tracking**: month-to-date spend comes from `usage_events` (eve chat usage must be recorded there too, as part of slice 2).
- **6c. Alert**: When the spend reaches 80% of the cap, an alert is created and sent to the owner via the outbox.

**Acceptance Criteria:**
- The cap setting is added to the schema and backfilled (null by default).
- The model spend is tracked and updated after each model call.
- The 80% alert is created and sent via the outbox.
- The cap is off by default (no alert if the cap is null).

## Possible Edge Cases
- **Shadow mode drift**: The eve schedule and Inngest function produce different results. The comparison log should highlight discrepancies.
- **Double-sends during cutover**: If the flag is flipped mid-cycle, ensure no double-sends occur. The outbox idempotency key should prevent this.
- **Memory privacy**: If a user forgets a memory entry, it should be purged immediately, not just on the next retention run.
- **Elder confirmation timeout**: If the elder does not confirm the `end_session` request within a timeout (e.g., 5 minutes), the request is cancelled and logged.
- **Twilio mock mode**: Ensure that no real Twilio API calls are made in mock mode, even if credentials are set.
- **Spend cap tracking**: If the model spend is tracked asynchronously, ensure that the cap alert is not delayed beyond a reasonable time (e.g., 1 hour).

## Acceptance Criteria
- All slices are implemented and unit-tested.
- The `NEO_EVE_SCHEDULES` flag is respected and tested.
- The eve chat parity is confirmed by the owner.
- The agent memory is scoped and retained correctly.
- The `end_session` tool is approved and executed correctly.
- The Twilio channel is mock-only and disabled by default.
- The model spend cap is tracked and alerted correctly.

## Open Questions
- **Elder autonomy**: Confirmed: elder must confirm on screen. (Owner decision)
- **Phones**: Out of scope for M3. (Owner decision)
- **Per-household monthly model spend cap**: Off by default, with an 80% owner alert. (Owner decision)
- **Inngest removal**: When is the owner-approved step to remove Inngest code? (pending owner decision)
- **Twilio A2P registration**: When to start? (pending owner decision)

## Testing Guidelines
Create test files in the `./test` folder for the new features, and create meaningful tests for the following cases, without going too heavy
- **Eve schedules**: Each job core in shadow and live mode with fake effects (same planned-action digest, shadow performs nothing). The `NEO_EVE_SCHEDULES` switch matrix. Schedule definitions load. Migration `0025_schedule_runs` on PGlite.
- **Eve chat parity**: Each intent (paste-a-link, email/SMS paste, playbooks, verdict cards, "Was this you?") is handled correctly.
- **Agent memory**: Memory is scoped per tenant/principal, retained correctly, and can be viewed/forget in the console.
- **`end_session` tool**: The approval flow is enforced, and the elder confirmation is required for elder devices.
- **Twilio channel**: The channel is mock-only and disabled by default.
- **Model spend cap**: The cap is tracked, and the 80% alert is sent.
