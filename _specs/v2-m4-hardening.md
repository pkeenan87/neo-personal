# Spec for v2-m4-hardening

branch: claude/feature/v2-m4-hardening
plan: `_plans/v2.md` (M4); architecture: `_specs/v2-architecture.md`
status: draft, 2026-11-03 (slice 5 built on claude/feature/v2-m4-evals)

## Summary

M4 hardens the v2 architecture for release. It introduces configurable data retention, formalizes consent and notice flows for Child and Elder modes, updates the privacy page and threat model, establishes an evaluation suite for agent behavior and policy determinism, and prepares a checklist for beta households. No new feature logic is added; this milestone focuses on safety, compliance, and operational readiness.

## Functional requirements

### 1. Retention (Slice 1)
- **Configurable per household:** Add `retention_settings` table (`tenant_id`, `signals_days`, `incidents_days`, `child_requests_days`, `schedule_runs_days`, `eve_sessions_days`, `updated_at`). Defaults: signals 30 days, incidents/alerts 365 days, child requests 90 days, schedule runs 90 days, eve sessions per eve's default (or 30 days if not specified).
- **Enforcement:** the retention job core (`apps/web/lib/server/schedules/`, M3 slice 1) reads each tenant's settings and purges older rows. By default Inngest runs it live and the eve schedule runs it in shadow (records what it would purge); `NEO_EVE_SCHEDULES=retention` swaps them. Defaults apply when a household has no row.
- **UI:** A household settings page (`/settings/retention`) displays the current retention policy and allows the owner to adjust values within safe bounds (e.g., signals min 7 days, max 365 days). Changes are logged in `audit_log`.
- **Edge case:** If a household has no `retention_settings` row, use defaults. If a value is out of bounds, clamp to min/max and log a warning.

#### Slice 1: what was built

- **Columns on `tenants`, not a `retention_settings` table.** Like the spend cap: four nullable integers with CHECK bounds (migration `0030_retention_settings`), null = default. One row per household already exists, RLS is the existing tenant policy, the settings route reuses the spend-cap shape, and the definer purges join `tenants` they already need. A table would add a second RLS policy and a lookup per purge for no gain.
- **Settings and defaults.** `signals_days` 30 (7-365), `incidents_days` 180 (30-1095), `child_requests_days` 90 (7-365), `memory_days` 365 (30-1095). Deviation from the draft: the alert default is **180, not 365**, because that is the existing rule (acknowledged alerts also go after 90 days) and defaults must reproduce today's behaviour. An acknowledged alert goes after the lesser of 90 days and the setting. `eve_sessions_days` and `schedule_runs_days` are not settings: `schedule_runs` is a fixed 90 days (the job log is not household data), eve sessions are eve's own.
- **Child requests** were never deleted before; decided or expired ones now go after the setting (default 90 days by `updated_at`; pending ones stay until `expire_child_requests` closes them).
- **Memory.** A purge removes entries past `expires_at` or older than the setting; `expires_at` is set from the setting when a fact is added, so a longer setting applies to new facts only.
- **Out of range is rejected** with 400 and the fields, not clamped (the draft said clamp): the form shows the bounds, and a silent change of a privacy setting is worse than an error. Non-owners see no section (the open question: hidden).
- **Settings are read by each purge statement**, so a change takes effect on the next run.
- **Shadow** records read-only counts per kind (`retention_preview`) with the household settings applied. See `docs/contracts.md`.
- **Not built:** a separate `/settings/retention` page (the section lives on Household settings), per-tenant planned actions in the shadow digest.

### 2. Consent and notice flow (Slice 2)
- **Parent-facing consent screen:** before enabling Child or Elder mode, the owner reads and accepts a plain-language screen in the console. Recorded in the existing `consents` table (M2) as `monitoring_notice` with `evidence { mode, textVersion }` (no new kind).
- **Elder self-consent:** For Elder mode, the elder must confirm their helpers on screen of their own device (via a deep link or QR code) or the owner must attest in person. This is recorded as `elder_self_consent` in `consents` (`type: 'elder_self_consent'`, `method: 'device' | 'owner_attestation'`, `attested_by`, `attested_at`).
- **'What is shared' page:** A new page (built at `/settings/household/members/[id]/shared`, see "Slice 2: what was built") lists exactly what data is collected, where it is stored, and who can see it. Each member can open this page from their device or the console.
- **Visible notice on devices:** Already implemented in M2 (extension and desktop show a "Neo is monitoring" badge). No change.
- **COPPA:** Verifiable consent for minors is deferred. The current flow (parent consent) is sufficient for Patrick's household. If outside households join, this becomes a gate.

#### Slice 2: what was built
- Owner decisions: family-first (COPPA verifiable consent deferred); for an elder, the elder's own confirmation is the intent, but this slice ships the owner attestation only.
- `apps/web/lib/consent-text.ts`: `CONSENT_TEXT_VERSION = "2026-11-04"`, the notice sections (what Neo watches, never collects, who sees alerts, how to turn it off), the attestation sentence and the "what is shared" content. Bump the version when the wording changes.
- Console: choosing Child or Elder shows the notice and a "I have read this and told <name>" checkbox; Elder adds "I set this up with <name> in person and they agreed to these helpers: ..." (the saved helper names). The Helpers form asks for the attestation again for an Elder whose helpers change.
- Server (`patchMember`): enabling a mode without the current `consentTextVersion` is 400 `consent_required`; Elder without `elderAttestation` (on enable or helper change) is 400 `attestation_required`. Both modes record `monitoring_notice` `{ mode, textVersion, band? }` through one path; Elder also records `elder_self_consent` `{ method: "owner_attestation", textVersion, helperIds }`. No migration, no new consent kind. Existing tests changed only to send the new field.
- `/settings/household/members/[id]/shared` (and `GET .../shared`): owners and the member themselves; another member 403, other household 404. Describes collection by mode and enrolled device kinds, never-collected list, owners and helpers by name, retention. Linked from the member page.
- Not done: the alert-email footer link to the shared page (skipped; touches every outbox template).

### 3. Privacy page update (Slice 3)
- Update `/privacy` to reflect v2 data:
  - Members without accounts (child/elder devices).
  - Signals are stored by category/domain only, never full URLs.
  - Policy bundles are signed and cached per device.
  - Child requests are stored for 90 days (configurable).
  - Household memory (`household_memory`, owner-approved facts) and eve chat sessions, each with their own retention.
  - Spend is tracked per tenant and capped.
  - Twilio is not active in M4 (SMS/voice deferred).
- Keep it as the existing page; add a test that lists the data categories the page must mention, so new tables without a privacy entry fail CI.

#### Slice 3: what was built
- `apps/web/app/privacy/page.tsx` (updated 2026-11-03): three new sections, "People in your household" (members without accounts, invitations, consent records), "Child and Elder protection" (signed settings, what a device reports, child requests and the typed reason, actions and the notification queue, category list sources and licences) and "The assistant, memory and spend" (eve chat, household memory, spend tracking, SMS not active), plus new retention lines and an audit-trail sentence.
- The numbers on the page are read from code (after slices 1 and 2 merged): signals 30 days, alerts 180 days (90 after acknowledgement), child requests 90 days, household memory 365 days, each owner-changeable within bounds (`packages/core/src/retention.ts`, migration 0030); artifacts 30 days, removed devices 90 days, schedule runs 90 days. Still no timed purge for consents, usage events, the audit trail, incident actions, the notification outbox, invitations, device commands (only marked expired) or `eve_sessions`; the page says they are kept until the household is deleted.
- Eve chat content is stored by eve on Vercel Workflow, outside our database; the page says Neo does not set its retention.
- CI guard: `apps/web/test/privacy-tenant-tables.test.tsx` (now including `deviceCommands`) maps every key of `tenantTables` to a privacy-page section and phrase. A new tenant table fails CI until the map (and the page) cover it. Tables, by section: `collect` conversations, turns, verdicts, monitoredAddresses, breachObservations, auditEvents, inboundAddresses, inboundMessages, devices, deviceEnrollmentCodes, deviceExpectedTools; `use` memberships, digestDeliveries, accountHardeningAnswers, signinEvents, knownSigninDevices, the four outlook tables; `retention` artifacts, alerts, deviceSignals; `people` members, householdInvites, consents; `protection` policies, policyBundles, incidentActions, notificationOutbox, childRequests; `assistant` usageEvents, eveSessions, householdMemory, memberChannels.
- Also described as built: consent records (slice 2), the `end_session` request and its device table `device_commands` (M3 slice 4), owner-set retention (slice 1).

### 4. SECURITY.md threat-model update (Slice 4)
Describe only mitigations that exist; anything missing is a residual risk or a follow-up, never a claimed control.
- **eve tools and sessions:** tenant from the verified caller only (`requireTenantCaller`), DB through `tenantScoped()`, every result through `wrapToolResult`; per-session owner check (`eve_sessions`, M1) on continue/stream/control routes; acting tools `always()` + a DB role re-check. Residual: eve's session storage (Vercel Workflow) is not encrypted per tenant by us.
- **Policy bundles:** ES256 via Vercel KMS (key never in env); clients pin public keys at build; device-bound (`deviceId`), rollback rejected (`issuedAt`), bad signatures reported as tamper. Residual: a compromised server can sign anything — signing proves origin, not intent; key rotation needs clients carrying both keys first.
- **Device commands (`end_session`):** carried inside the signed bundle, bound to the device, deduplicated by id, expire after 10 minutes, elder confirms on screen. Residual: needs verification on real hardware.
- **Email decision links:** a random 32-byte token stored hashed, single-use, 24 h; it only identifies the request — a signed-in owner must confirm. Residual: a forwarded email lets another signed-in owner of the same household decide.
- **Twilio webhooks (off, mock-only):** `X-Twilio-Signature` checked on every request; unknown numbers never reach the model. No IP allowlisting.
- **Category lists:** pinned upstream commits, sha256-checked at build, served from our origin, sha256-checked by the extension against the lists manifest. Residual: the manifest itself is not signed (same trust as the server); upstream lists can contain mistakes (false positives → allow lists).
- **Household memory:** a prompt-injection persistence channel by design — mitigated by owner-only writes with `always()` approval showing the exact text, server-side content rules, no automatic injection into the system prompt (only via `recall` → `wrapToolResult`), retention and forget. Residual: an owner can approve injected text.
- **eve schedule shadow runner:** read-only by type (no effects object), records counts/digests only (no PII) in `schedule_runs`; cron routes only reachable with Vercel's cron token (probed: 404 otherwise).

#### Slice 4: what was built
- `SECURITY.md`: a "v2 trust boundaries" section and an "Owner actions" list. Each control cites its file. Corrections to the draft above, found while verifying against code: the env-key signing backend (`NEO_POLICY_SIGNING_KEY`) exists beside KMS, so "key never in env" is true only for KMS; the desktop agent verifies signature, pinned keys and `deviceId` but has no `issuedAt` rollback check (the extension has one); the email token is single-use in that it is cleared when the request is decided; nothing in the repository enforces "cron routes only reachable with Vercel's token", so that is listed as unverified, with a probe in the beta checklist; `end_session`, consent and owner-set retention have since merged and are described as built, with the desktop rollback gap, the missing timed purges and the unverified cron token kept as residual risks.
- Added as requested: household memory as an injection-persistence channel with its controls and residual, and "signing proves origin, not intent".

### 5. Evals (Slice 5)
- **Offline evals (run in CI, no network, no real model):** the safety properties that do not depend on the model's prose. A scripted, adversarial "model" drives the real tool definitions against an in-memory Postgres (PGlite).
  - An acting tool (`mark_expected`, `allow_once`, `approve_request`, `deny_request`, `confirm_signin`) never executes without an approval, nothing happens until approved, and nothing happens on deny. Every tool in `agent/tools` must be classified acting or read-only, so a new tool cannot be added unreviewed.
  - Every tool result reaches the model inside the `wrapToolResult` envelope.
  - The tenant comes from the caller: a `tenantId` in any input is rejected, and another household's ids come back `not_found` even after approval.
  - Prompt-injection fixtures (email, SMS, fetched page, child request reason, alert body, memory entry): the scripted model obeys the injected "call allow_once / approve_request / mark_expected"; the gate still parks the call, nothing changes, and the text appears only inside the envelope.
  - Elder tone: the instructions file keeps the tone and approval rules (a guard against deletion).
  - Policy engine: one table for the five Elder rules and Child's parity (fires / does not fire).
- **Live evals (optional, never in CI):** `apps/web/evals/*.eval.ts`, skipped unless `NEO_LIVE_EVALS=1`. They check what only a real model can show: the Elder reply starts with stop / hang up, uses no shaming words, and the model itself declines to call an acting tool because pasted data said so.
- **Not claimed:** the offline suite proves the deterministic layer (approval gate, envelope, tenant scoping); it says nothing about whether the model resists an injection or keeps a calm tone. It mirrors eve's contract (approval is decided from the tool definition; the model sees `toModelOutput`) without running eve's runtime, so a change in how eve applies `approval` is caught only by the live evals.

#### Slice 5: what was built
- `apps/web/agent/evals/` (vitest, included in `pnpm test`, also `pnpm --filter @neo/web test:evals`): `harness.ts` (the scripted loop, approval gate and adversarial model), `safety.test.ts`, `injection.test.ts`, `instructions.test.ts`. About 50 cases, under 3 s in total.
- `packages/core/test/policy-matrix.test.ts`: the rule x mode table. The per-rule edges stay in `policy.test.ts` and `child-policy.test.ts`, which were already exhaustive for Elder and Child.
- `apps/web/evals/` (eve's `evals/` directory at the app root, as eve requires): `evals.config.ts`, `elder-tone.eval.ts`, `prompt-injection.eval.ts`. Run with `NEO_LIVE_EVALS=1 pnpm --filter @neo/web test:evals:live`. Budget: five model turns, a few cents on the default routing. Without the flag every case reports as skipped.
- Proven offline: the five acting tools park for approval and are inert on deny; envelope on every result; tenant isolation; injected text never leaves the envelope; Elder instructions present; policy rules.
- Needs a live eval: tone of the reply, the model declining an injected instruction, and eve applying `approval` at runtime. Stand-ins: the fetched page and memory entry fixtures use a read-only stub tool because there is no offline page fetch and no memory tool on main yet; they cover the envelope and the gate, not a real memory write. `remember` and `end_session` are not on main, so they are not in the acting list; when they land they must be added to `ACTING` (the classification test fails until they are).

### 6. Beta households (Slice 6)
- **Checklist doc only:** A document in `docs/beta-checklist.md` that lists the steps for onboarding a beta household:
  - Create the household and members.
  - Enroll devices.
  - Configure modes and policies.
  - Set up retention and consent.
  - Monitor usage and incidents.
  - Collect feedback.
- No code changes.

#### Slice 6: what was built
- `docs/beta-checklist.md`: operator gates (COPPA, pinned policy key in client builds, hardware verification list from the M2 spec, store releases, list licences, cron probe, flags) and a 14-step household onboarding including Chromebook and Family Link (unverified), notification checks, spend cap, retention as it is today, and how to report problems. Items that depend on unmerged work are marked pending.

## Possible Edge Cases
- A household changes retention settings while a purge is in progress: the purge uses the settings at the start of the run.
- An elder refuses to confirm their helpers: the owner can attest in person, but this is logged and flagged for review.
- A policy signing key is compromised: devices accept anything it signs until clients with a new pinned key ship — documented as a residual risk with the rotation runbook.
- A prompt-injection fixture is too subtle: the evals suite flags it for manual review.

## Acceptance Criteria
- Retention settings are configurable per household and enforced by the retention schedule job.
- Consent and notice flows are implemented for Child and Elder modes, with elder self-consent recorded.
- The privacy page is updated to reflect v2 data.
- SECURITY.md is updated with new trust boundaries and mitigations.
- The evals suite passes in CI, with no prompt-injection fixtures succeeding.
- The beta checklist doc is complete and reviewed.

## Open Questions
- **Owner decision:** Should the retention settings be visible to non-owner members? (Currently, only the owner can change them.)
- **Owner decision:** Should the elder self-consent be required for all helpers, or just the primary helper?
- **Owner decision:** Should the privacy page be translated into other languages? (Currently, English only.)
- **Owner decision:** Should the evals suite include a live model test (with a small budget) in addition to the mock model?

- **Open (consent slice):** device-side elder confirmation (the elder confirms their helpers on their own device via a deep link or QR, recording `elder_self_consent` `method: "device"`) is a follow-up; until then the owner's attestation is the only method.
- **Open (consent slice):** COPPA verifiable parental consent is deferred (family-first). If households outside the family join, it becomes a gate before Child mode.
- **Open (consent slice):** the "what is shared" page's retention lines are static until owner-set retention (slice 1) is enforced.

## Testing Guidelines
- **Retention:** Test that the purge job respects the configured thresholds and that changes to settings take effect on the next run.
- **Consent:** Test that the consent screen is shown before enabling Child or Elder mode, and that elder self-consent is recorded correctly.
- **Privacy page:** Test that the page is generated from the config file and that all v2 data is listed.
- **SECURITY.md:** Test that the new trust boundaries are documented and that the mitigations are in place.
- **Evals:** Run the evals suite in CI and ensure that no prompt-injection fixtures succeed. Test that the policy engine fires and doesn't fire as expected.
- **Beta checklist:** Review the checklist doc and ensure that all steps are clear and actionable.
