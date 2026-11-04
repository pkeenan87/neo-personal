# Spec for v2-m3-cutover

branch: claude/feature/v2-m3-cutover
plan: `_plans/v2.md` (M3); architecture: `_specs/v2-architecture.md` (§4, §5)
status: draft, 2026-11-03 (slices 1, 2, 4 and 5 built; slice 6 built on `claude/feature/v2-m3-spend-cap`)

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

#### Slice 3: what was built

Differences from the draft above (decided with the owner's rules in mind; the draft's table sketch is superseded):

- **App table, not eve's memory.** eve's `fileMemory()` (`eve/memory/file`) keeps one model-maintained document per scope in Vercel Blob; the model edits it with its own save/remove tools and the provider "gives the model the whole document" every turn. That fails every rule here: the model (not the owner) would write, text from a tool result could be saved, nothing is tenant-scoped by RLS (the scope key is a principal), the owner cannot see or forget entries in the console, retention is not ours, and the content goes into the prompt automatically. A custom provider could fix some of this but would still need our table for RLS, console and purge. So: table `household_memory`, no eve memory slot, and nothing is injected into the system prompt; memory reaches the model only through the `recall` tool.
- **Table** (migration `0028_household_memory`, journal `when` `1793633226799`): `household_memory(id, tenant_id fk cascade, subject_member_id fk members set null nullable, text <= 280, created_by fk users set null, source 'console'|'chat', created_at, expires_at)`; tenant RLS; in `tenantTables`; index `(tenant_id, created_at)`. `subject_member_id` replaces the draft's `principal_id` and `key`/`value`: a fact is free text about the whole household (null) or about one member. At most 100 live rows per household (checked with the insert under a per-household advisory lock). `purge_expired_household_memory(now)` is a security-definer function (like `expire_child_requests`), run by the retention job.
- **Writes** are owner-only and re-check the owner in the database at that moment (`requireHouseholdAdmin`): the console (member page "What Neo remembers about X", household page "What Neo remembers", routes `/api/household/memory`) and the eve tool `remember { text, subjectMemberId? }` (`approval: always()`; the prompt quotes the exact text, hidden characters spelled out). The stored text is checked on the server for both paths (`lib/server/memory-rules.ts`): at most 280 characters, no control, format (zero-width, bidi), line-separator or private-use characters; no `@` (emails, handles); no run of seven or more digits (phone, card, bank numbers); no URL scheme, `www.`, or bare domain on a TLD list; no password, PIN, code, key, secret or token words and key-shaped strings; no card, bank, IBAN or tax-number words. It is a blocklist and errs towards refusing.
- **"The text came from the owner's own turn" is not enforceable in a tool.** `execute` cannot see the user's message reliably, and an attacker can phrase injected text to look like the owner's. So the control is the approval prompt, which shows the exact words the model wants stored: the owner is the check. The instructions tell the model to call `remember` only with words the owner said in their own message, never from a tool result, email, SMS, page, alert or child's request. A model that is talked into calling `remember` still needs a human to approve the exact text, and the text still has to pass the content rules.
- **Reads:** `recall {}` (read-only) returns the live entries through `wrapToolResult` (evidence, not instructions): an owner sees all; any other member sees the household-wide entries and those about themselves (role and member re-read from the database, never from the caller's claim). Instructions say to treat notes as dated evidence.
- **Forget** is console-only (owner), a hard delete at once; the agent has no forget tool. **Retention:** 365 days (`expires_at`), purged by the retention job (`runArtifactsExpire` `purgeExpiredMemory`, shared by the Inngest function and the eve schedule; shadow mode records it as the planned purge `household_memory`). A purge failure (e.g. migration not yet run) logs and does not break retention.
- **Audit:** `memory.added` `{ memoryId, length, source, aboutMember }` and `memory.forgotten` `{ memoryId }`; never the text.
- **Postgres only:** without `DATABASE_URL` the console answers 503 and `recall` reports memory unavailable (the eve process always has a database).
- **Known limits:** a determined owner can still word a secret past a blocklist (the owner is trusted; the rules stop the model and typos); an entry about a member who is later removed becomes household-wide (`set null`), so remove such entries first; there is no edit, only forget and re-add.

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

#### Slice 4: what was built, and the decisions
Built as migration `0029_device_commands` (journal `when` `1793633286799`, journal `idx` 26 because 0027 and 0028 are on other branches); interfaces in `docs/contracts.md` ("M3 slice 4"). **The snapshot chain needs a check after 0027 and 0028 merge:** `0029_snapshot.json` has `prevId` = the id of `0026_snapshot.json`, so it must be re-pointed at the newest snapshot (and regenerated from the final schema) when they land. `drizzle-kit generate` overwrote `0026_snapshot.json` here because the file prefix collides with the journal position; that file was restored from git.

- **The tool.** `end_session { incidentId }` (`apps/web/agent/tools/end_session.ts`, logic in `lib/server/end-session.ts`), `approval: always()`. The input is the incident id only (a strict schema); the device, tool and remote ID come from the incident's own stored `remote_access_session` signals (an incoming session of a tool in the catalog; a tool-install alert or an outgoing session is refused as `no_session`). At execution: `requireHouseholdAdmin` against the database, the incident is open, the device is an active `desktop_agent` with a member, and it has been **in contact within 2 minutes** (else `device_offline`, "Neo can't reach that device right now. Nothing was sent.", and the refusal is recorded). At most 6 requests per device and hour. One open command per device and tool: asking again returns the existing one. It writes the `device_commands` row, an `incident_actions` row (`end_session`, `pending`, `{ commandId, toolId, requiresConfirmation }`) and the `incident.action` audit event. The result says "Requested ... waiting for <name> to confirm on screen ... nothing has ended yet"; it never says the session ended, and `instructions.md` tells the model the same (and no longer says it "cannot end a session").
- **Confirmation rule (owner decision: the elder always confirms; the rest is my choice).** `requires_confirmation = true` **unless the device's member is in Child mode**. So an Elder, a Standard member and even the owner's own computer confirm on screen; only a child's computer takes the parent's request without a prompt. This is the safer reading of "a helper alone cannot end an elder's session"; see Open Questions.
- **Delivery.** The command is part of the device's signed bundle: `commands: [{ id, kind, sessionRef: { toolId, peerId? }, requiresConfirmation, expiresAt }]`, in every mode, absent (not `[]`) when there is none, so no existing `policyVersion` changes; sorted by `id`; expired ones are dropped by the compiler; a pending command, its fields and its expiry are all part of `policyVersion`. `processRef` was dropped: the session signal has no pid, so there is nothing to put in it. `kind` is a plain string in the schema, so a client that does not know a future kind still verifies and applies the bundle (and ignores the command). The row is marked `delivered` when a 200 policy response carrying it is served (not on a 304). The 10-minute expiry is `expires_at`; an unanswered row is marked `expired` by the 5-minute `outbox-sweep` (see "No silent expiry" below; the bundle drops it by time alone).
- **Liveness and the fast poll.** `devices.last_seen_at` was written only by the hourly heartbeat, so a short contact window would almost always fail. Decided: **a policy fetch (200 or 304) counts as contact** (`servePolicy` calls `recordHeartbeat`). And the agent polls `GET /api/devices/policy` every 60 s (120/hour limit) while (a) a remote session is active (watched through the tool's programs) or ended less than 10 minutes ago, (b) the heartbeat said `pendingCommand: true` (new, additive; for 10 minutes), or (c) a confirmation is open. Without one of these it fetches the policy only when the hourly heartbeat's `policyVersion` differs. So a session the agent saw is reachable within about a minute; a command to an agent that saw nothing waits up to an hour and probably expires, which is why the tool asks for recent contact.
- **No silent expiry.** (1) *Watching a session.* A session is reported once (its log line or event) and has no "ended" signal, so the agent watches it through the tool's programs (`neo-agent-core::commands::SessionWatch`): while any process of the tool runs the session counts as active and the poll stays on, with no 30-minute cap; ten minutes after the last sign it stops (a tool the lists name no programs for gets a fixed 30 minutes from the report, since its end cannot be seen). The server's liveness check is two minutes (`END_SESSION_LIVE_WITHIN_MS`): an armed agent polls every 60 s so it always passes, an unarmed one is refused with "Neo can't reach that device right now", so a request is never accepted for a device that cannot see it in time. (2) *Eager expiry.* The 5-minute `outbox-sweep` job core (both runners; shadow records `command.expire` actions and counts them, live acts) marks every open `device_commands` row past `expires_at` as `expired` (SECURITY DEFINER functions `list_expired_device_commands` and `expire_device_commands` in migration 0029, because the sweep crosses households), sets the pending `end_session` action to `failed` with `result.reason = "expired"`, and audits `device.command_expired`. The incident stays open. `get_incident` gains `endSessionRequests: [{ status, note, at }]` (only when there were requests), one line per request with fixed wording, for example "The request to end the session expired — the device didn't respond." (3) The tool's result says it is a request that expires in 10 minutes if the computer does not answer.
- **The answer.** New signal `command_result { commandId, outcome: done|declined|failed|expired, detail? }` (`type: "command"`). Server first. `ingestSignals` handles it before the policy engine: the command must exist and belong to **the calling device** (else `rejected: invalid`); the row is closed once (`done|declined|failed|expired`, atomic on the status; a second answer or a retried batch is `duplicate`); an `incident_actions` row is appended (`done` | `rejected` for declined and expired | `failed`; the table is append-only); on `done` the incident is **resolved**; on every other outcome it stays open for the owner; the audit event is `device.command_result`. `detail` is stored only if it is one of a fixed set of codes (`closed`, `not_running`, `protected`, `close_failed`, `tray_unavailable`, `not_supported`, `no_answer`, `kept`), so a compromised device cannot put text into an alert. `confirmed` is a legal status that nothing sets yet (the agent reports only the final outcome).
- **The agent.** `neo-agent-core::commands` (pure) and `agent-service/src/agent/commands.rs` (glue), outside the Child-mode gate. It reads `commands` from the verified bundle; acts on each id once (`commands.json` keeps the last 200 ids for 24 hours, so a restart or a replayed old bundle does nothing); answers an expired command `expired` without acting. With `requiresConfirmation` it pushes `{ push: "confirm", id, kind: "end_session", title: "Your helper asked to end the remote session from <Tool>.", body: "End it now?", expiresAt }` to the tray, which opens a topmost window with "End the session" and "Keep it" and answers with the pipe op `command_answer { id, answer }`. **No answer in 2 minutes is `declined` (`no_answer`)**, or `expired` if the command's own 10 minutes run out first. With **no tray app subscribed** there is nobody to ask: the command fails (`tray_unavailable`) and nothing is closed. On "End" (or at once, when no confirmation is needed) it closes the tool's processes: the running processes whose image name is in the tool's `processNames` or session-evidence `process` names (or whose macOS bundle id is one of the tool's), through the same guards as app blocking (`protected_reason`: not Neo, not the system, not a service or SYSTEM, not under `%WINDIR%`, not Apple-signed or root-owned, and a fact it could not read protects the process) and the same `Actuator::terminate`. Outcomes: nothing running is `done`/`not_running`; only protected processes is `failed`/`protected`; none closed is `failed`/`close_failed`; else `done`/`closed`. The result is queued as `command_result` in the normal event queue (not counted against the Child-mode daily cap).
- **Extension.** No code change: it verifies the raw bundle, and `commands` is an optional field of `PolicyBundleSchema`. A test confirms a bundle with commands (and with an unknown kind) verifies and applies, and one whose command was changed after signing is rejected.
- **Not built / limits.** Retention does not purge `device_commands` rows (they go with the device; one per request, owner-initiated). An agent build that predates this ignores the command, which then expires unanswered (`expired` is never reported by it, so the sweep expires the row after its 10 minutes). The prompt is shown only on a push: a tray that connects while a prompt is open does not get it (it declines after two minutes).
- **Verify on real hardware** (everything above is proven on Linux with fakes only):
  1. **Windows:** `TerminateProcess` on the person's `AnyDesk.exe` / `TeamViewer.exe` from the SYSTEM service ends the remote session, and what the remote side sees. These tools often keep a **SYSTEM service in session 0** (`AnyDesk.exe --service`, `TeamViewer_Service.exe`); that process is protected and is never closed, so the result is `closed` when the user-session client was running (and the remote may reconnect through the service), and `protected` when only the service was. Whether closing the user-session process is enough to drop the session, and whether the service re-launches it, is unverified.
  2. **macOS:** `SIGTERM`/`SIGKILL` on an app the person runs; AnyDesk/TeamViewer helper processes under `root` are protected like the Windows service. Apple Screen Sharing is Apple-signed, so it can never be ended this way (`protected`).
  3. The tray window: topmost and focused on both OSes, readable, and the answer reaches the service (the Tauri window, the `confirm`/`confirm_done` pushes and the `command_answer` op are tested only as far as the pure logic and the React view).
  4. The timing: the minute poll after a real session event, end to end from the chat.

### 5. Twilio SMS/voice channel (Slice 5)
Code for the Twilio SMS and voice channels is added behind a flag. No Twilio account or A2P registration is done in M3; the code is mock-only.

- **5a. Channel code**: Implement the Twilio channel in `apps/web/agent/channels/twilio.ts` (or similar). It handles inbound SMS/voice and outbound messages.
- **5b. Mock mode**: In mock mode, the channel logs messages instead of sending them.
- **5c. Flag**: The channel is enabled only if `NEO_TWILIO_ENABLED=true` and the Twilio credentials are set.

**Acceptance Criteria:**
- The Twilio channel code is implemented and unit-tested.
- In mock mode, messages are logged and not sent.
- The channel is disabled by default.

#### Slice 5: what was built, and the decisions
Built as migration `0026_member_channels` (journal `when` `1793633106799`); interfaces in `docs/contracts.md` ("M3 slice 5"). **No Twilio account, no A2P, no real sends**: the code path exists behind the flag and is mock-only.

- **Flag.** `NEO_TWILIO_ENABLED` must be exactly `true`. Unset, every `/eve/v1/twilio/*` route answers 404 without running eve's handler (checked per request), and the console's "Connect a phone" routes and section are hidden (404). The credential variables (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`) are listed in `.env.example` and are not used until A2P registration.
- **Mock-only, unconditionally.** There is no Twilio client. `SmsSender` has one implementation (the mock, which logs a hash of the number), and eve's channel gets `api.fetch = mockTwilioFetch`, so replies, approval prompts and MMS downloads cannot reach the network even if credentials are set. A real sender is a second `SmsSender` implementation plus dropping the `api.fetch` override, after A2P.
- **Webhook signature.** Always on (eve's built-in check). `TWILIO_AUTH_TOKEN` when set; otherwise a fixed test token in MOCK_MODE off a deployed environment; otherwise no token and every webhook is rejected (401).
- **Caller auth is `onText`.** eve's Twilio channel has no auth walk: `allowFrom: "*"` admits every number to `onText`, which maps the number to a member only through a verified `member_channels` row (`lookup_member_channel`, security definer, because no tenant is known yet). The tenant, member and role come from that row, never from the message. An unknown or merely claimed number gets "This number isn't connected to Neo." (rate limited per number) and `onText` returns `null`, so eve never starts a session.
- **Linking a number.** The owner enters an E.164 number on the member page; an unverified row stores an HMAC of a six-digit code (10 minutes). Five wrong codes burn it (the counter is persisted, so a restart or another instance cannot reset it); a new code restarts the counter. A number already verified by anyone is refused with a generic 409. At most 3 numbers per member. Disconnecting deletes the row, so the number stops resolving at once.
- **Outbox.** `sms` is a legal `notification_outbox.channel` (in 0026) but nothing enqueues one and the drain claims `email` rows only; email delivery is unchanged. The contact envelope (`encryptContact`) is email-only, so SMS destinations and drain dispatch to the mock sender wait for A2P; the drain claims `email` rows only (a behaviour-preserving filter in `claimOutboxRows`) so a stray `sms` row can never break email delivery.
- **Voice (later).** `onVoice` rejects calls (403) and transcripts are ignored. Voice needs its own spec: consent and recording disclosure, and a spoken-confirmation story for approvals.
- **Not done.** Inbound STOP/HELP handling, outbound opt-in records, quiet hours and a real sender are A2P work. Sessions started over SMS use eve's default per-number session keying. Behind the Next rewrite eve sees `http://127.0.0.1:4274/...`, so real signature verification will need `webhookUrl` (and `publicBaseUrl` for voice) set to the public URL. Without `DATABASE_URL` the memory twin lives in the Next process while eve is a separate process, so a number verified in the console only resolves in the eve server when the database is on.

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

#### Slice 6: what was built

- **Setting.** `tenants.monthly_spend_cap_cents integer null` (migration `0027_spend_cap`; CHECK null or 100 to 1,000,000 cents, so $1 to $10,000). Null is off and is the default for every household. Owners set it on Household settings, "Monthly AI spend cap" (`GET`/`PUT /api/household/spend-cap`, browser session, `requireHouseholdAdmin`); audit `household.spend_cap_changed { from, to }`. The section shows month-to-date spend and percent used.
- **Spend is an estimate from `usage_events`.** The table stores tokens and model, not cost, so cost is computed (`estimateCostCents` in `@neo/core`, `spend.ts`) from the catalog's `pricing` in `packages/core/src/routing.ts` (USD per million tokens at the AI Gateway global rate; source: the gateway model catalog the routing table already uses). Cache reads count at 0.1x and cache writes at 1.25x of the input price. A model id the catalog does not know is priced at the dearest catalog rate (over-count rather than miss spend). A gateway fallback to a cheaper model is invisible in the row, so the figure errs high. All `usage_events` kinds count, including background triage.
- **Month.** The calendar month in the household time zone (`tenants.time_zone`, null reads as UTC), `[local midnight on the 1st, local midnight on the 1st of next month)`. The reset time shown to the user is the end of that window.
- **Enforcement (chat only).** Before a chat turn, after the existing check caps pass: spend at or above 100% of the cap refuses. The old chat answers `429 { error: "spend_cap_exceeded", limitCents, resetAt, message }` with `Retry-After`; the eve chat's `gateTurn` returns the same sentence as the canned refusal. The sentence is a template, never model-written. If the usage store cannot be read the turn fails closed (503 `usage_unavailable` in the old chat, "can't check your usage" in eve), as for the check caps. `POST /api/agent/confirm` (a resumption of a turn that was already allowed) follows the existing precedent: only the daily token cap applies, so an approved action can finish.
- **Background jobs are exempt.** Triage of forwarded email and device-signal handling never read the spend cap: a household at its cap must keep getting security alerts. Their usage still counts toward the spend, and the cap alerts still fire when their usage crosses a threshold.
- **Alerts.** New alert kind `spend_cap` (`alerts_kind_check` re-added with every existing kind plus `spend_cap`). At 80% a `medium` alert and at 100% a `high` alert, both templated, owners only (no subject), once per household month each through the dedupe key `spend_cap:<tenantId>:<YYYY-MM>:80|100` (no new table). They are raised right after usage is recorded (`recordUsage`) and again at the chat gate, so a crossing is not delayed to the next turn. They go through `raiseAlert` and the outbox, and are emailed to every owner whatever their alert threshold (like child requests; `isCapExemptAlertKind` also exempts them from the daily email cap). The key does not include the cap, so changing the cap mid-month does not re-alert a threshold already alerted that month.
- **Not built.** A spend line in `/api/usage`; per-member spend; a hard stop for background jobs; real billing figures from the gateway.

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
- **`end_session` confirmation outside Elder mode**: built as "the person at the computer confirms unless their member is in Child mode", so a Standard member and the owner's own computer also confirm. Is that right, or should an adult be able to ask for their own session to be ended without a prompt? (pending owner decision)
- **A scammer who controls the mouse can click "Keep it"**: the prompt is an on-screen button like any other, and the service cannot tell who clicked. Confirmation protects against a helper overriding a person, not against a scammer who already has the keyboard. Is a second channel needed (the helper phones the elder, or a code the elder reads out)? (pending owner decision)
- **`end_session` liveness**: a policy fetch counts as contact and "within 2 minutes" is checked against it (an agent that watches an active session polls every minute, so it passes); a device the agent has not seen a session on is only polled hourly (see "Slice 4: what was built"). Is that enough, or should the agent poll faster while enrolled on an Elder's computer (a minute-poll all day costs 60 requests an hour per device)? (pending owner decision)
- **Snapshot chain after 0027 and 0028**: re-point `0029_snapshot.json`'s `prevId` at the newest snapshot and regenerate it from the final schema once those merge. (pending, mechanical)
- **No tray app**: with nothing to show the prompt in, `end_session` fails rather than ending the session unconfirmed. A message-box fallback cannot collect an answer. Acceptable? (pending owner decision)
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
