# Spec for v2-m1-elder

branch: claude/feature/v2-m1-elder
plan: `_plans/v2.md` (M1); architecture: `_specs/v2-architecture.md` (§2–§5)
status: draft, 2026-11-02

## Summary

M1 makes Elder mode real for Patrick's family:
- Every household member gets a `members` row with a mode.
- The signal rules become a mode-aware policy engine in `packages/core`.
- Alerts gain an incident status.
- Critical alerts reach the elder's helpers by templated email through an outbox.
- An eve chat explains an incident and offers two safe actions.

The current chat (`/api/agent`) stays live throughout. M1 ships in four PRs (§1), each green and deployable on its own.

## Corrections to the architecture spec (made in this PR)

The code trace on 2026-11-02 showed that two claims in `_specs/v2-architecture.md` §3/§5 and in `docs/contracts.md` (v2, planned) were wrong:
- **Correlation is not in Inngest.** `scam_in_progress` (a high scam page plus a remote-access signal within 30 minutes, across the member's devices) already runs inline in `apps/web/lib/server/signals/rules.ts` (`evaluateEvent`, `findScamInProgress`) and `apply.ts`. It is already deterministic. M1 moves it into `packages/core`. It does not invent it.
- **`signal-escalate` is enrichment.** It runs reputation lookups (`analyzeUrl` for `lookalike_login`, Safe Browsing for `dangerous_site`, VirusTotal for unsigned binaries). It makes network calls, so a pure engine can't replace it. In M1 it **stays on Inngest** as the enrichment step. Its result goes back through `evaluateSignal` as an enriched signal (`enrichment: { verdict, severity }`), so the engine still decides severity and actions. It moves with the other Inngest jobs in M3.

Both documents are amended in this PR.

## Functional requirements

### 1. Slices (one PR each, in order)
1. **Data + engine:** migration 0017, members backfill, `policies`, incident columns on `alerts`, `incident_actions`, `notification_outbox` (table only), and the policy engine in `packages/core` wired into `POST /api/signals`. Behaviour for Standard members is unchanged.
2. **Outbox + recipients:** alert email moves onto the outbox, helpers become recipients, and the drain is built.
3. **eve on main:** promote `claude/spike/eve`, add the in-process session lookup and read-only tools, and the `/chat-v2` incident chat behind a flag.
4. **Console + actions:** member and mode pages, helpers, notify rules, and the `mark_expected` and `allow_once` acting tools.

### 2. Members (slice 1)
- Migration `0017_v2_members.sql`. 0016 stays reserved for the Outlook connector (#50). If #50 merges first, renumber nothing.
- `members` per `docs/contracts.md`: `id`, `tenant_id`, `user_id` (nullable, unique per tenant), `display_name`, `role` (`owner|adult|child|elder`), `mode` (`standard|child|elder`), `birth_year`, `helper_member_ids uuid[]`, `contact` (encrypted, via `packages/core` artifact crypto), and timestamps.
  - The tenant RLS policy `tenant_isolation` is set as in 0010.
  - Add the table to `tenantTables` (`packages/db/src/tenant.ts`) and `schema/index.ts`. `create-app-user.sql` default privileges cover the grant.
- **Backfill:** one row per `memberships` row.
  - `display_name` comes from `users.name`, falling back to the email local part.
  - Role `owner` becomes `owner`, and `member` becomes `adult`.
  - Mode is `standard`.
- `devices.member_id` and `device_enrollment_codes.member_id` are added nullable and backfilled through `user_id`. New rows set both.
- **Decision: in M1 every protected member has an account.** An elder accepts an invite once, in person, while the helper installs the agent. This fits the existing "install in person" rule. `devices.user_id` stays NOT NULL. Member-only devices, with nullable `user_id` and reads moved to `member_id`, land in M2 with Child mode, because children are the members who usually never sign in.
- A new member gets a `members` row in the same transaction as their membership (invite accept, household creation). Removing a member deletes the row.

### 3. Modes and policies (slice 1)
- `policies` table per contracts: append-only, highest `version` per (`scope`, `scope_id`) wins. M1 writes `member` scope only. `household` and `device` are read but have no UI until M2.
- `PolicyRulesSchema` (zod, `@neo/verdict`). M1 fills only:
  - `remote_access`: `{ unknownPeerSeverity, sessionWindowMinutes }`
  - `payments`: `{ underPressureWindowMinutes }`
  - `notify`: `{ helpersNotifyAt: Severity, ownersNotifyAt: Severity }`
  
  Other sections exist as optional and are ignored.
- `MODE_DEFAULTS` are code constants:
  - `standard` reproduces today's rules exactly.
  - `elder` raises severities per §4 and sets `notify.helpersNotifyAt: "high"`.
  - `child` equals `standard` until M2.
- `effectivePolicy({ household?, mode, member?, device? })` deep-merges in that order. Unknown keys are dropped.

### 4. Policy engine (slice 1)
- `packages/core/src/policy/`: `evaluateSignal(policy, signal, recent) → Decision`. It is pure, with no I/O or clock. `now` comes in with the signal's `receivedAt`.
  - It absorbs `evaluateEvent`, `bumpSeverity` and `findScamInProgress` from `apps/web/lib/server/signals/rules.ts`.
  - `rules.ts` becomes a thin adapter. The dedupe keys stay byte-identical.
- `Decision` per contracts, plus `escalate: boolean`, which queues enrichment as today. `notifyNow` is true when the severity meets the member's `notify` thresholds.
- **The five Elder rules:**

  | # | Rule | Input today | Elder decision | Standard (unchanged) |
  | --- | --- | --- | --- | --- |
  | 1 | Remote session from an unknown peer | `remote_access_session` with an expected tool but a peer not in `peer_ids` | critical, `remote_access`, notifyNow | high |
  | 2 | `scam_in_progress` | high `scam_page`/`dangerous_site` + remote-access signal within 30 min | critical, notifyNow; Elder also counts a high `lookalike_login` | critical (same correlation) |
  | 3 | Suspicious install during a session | `unwanted_software` or `tcc_grant` within `sessionWindowMinutes` (default 30) after a non-baseline `remote_access_session` on any of the member's devices | critical, new kind `install_during_session` | medium |
  | 4 | Payment page under pressure | new detector `payment_page` within `underPressureWindowMinutes` (default 60) after a scam page or remote session | critical, new kind `payment_under_pressure`; alone: medium | recorded |
  | 5 | Protection disabled | server-generated: the extension uninstall beacon (`/api/devices/uninstalled`) or the `devices-offline` sweep | high, new kind `protection_disabled`, notifyNow | today's `device_offline` alert / no alert |
- **Rule 4 is dormant in M1.** `payment_page` is accepted by the server (added to `SIGNAL_DETECTORS`, server first per contracts), but no client sends it yet. The extension detector ships in the M2 extension release.
- **Rule 5** needs no client change. The uninstall route and the offline sweep call a server-side `recordServerSignal(deviceId, "protection_disabled", …)`, which runs through the same engine. That signal is never accepted from clients.
- The new alert kinds `install_during_session`, `payment_under_pressure` and `protection_disabled` are added by dropping and re-adding `alerts_kind_check`, as 0010 does. Their template text goes in `lib/server/alerts/templates.ts` and is not written by the model.
- **Enrichment:** when `signal-escalate` gets a lookup result, it calls `evaluateSignal` again with `enrichment` set, and applies that decision. A failed lookup still dismisses the signal and never alerts.

- **Built (slice 1), decisions made in implementation:**
  - `Decision.correlations` is an array, since one signal can complete more than one correlation. Each one becomes its own alert, deduped by `<kind>:<userId>:<30-minute bucket>`, and `scam_in_progress` keeps its existing key.
  - Rules 3 and 4 are switched on by policy, not by mode name: they run only when `remote_access.sessionWindowMinutes` or `payments.underPressureWindowMinutes` is set, and the Elder defaults set both. Rule 5 likewise reads `devices.protectionDisabledSeverity`.
  - Only an incoming, non-baseline remote session that alerted at **high or above** (unknown peer or unexpected tool) arms rules 3 and 4. A helper's own expected session doesn't arm them.
  - A `payment_page` on its own raises kind `payment_under_pressure` at medium.
  - Server signals (`protection_disabled`) aren't saved as `device_signals` rows; they only raise the alert, alongside today's `device_removed` and `device_offline` alerts.
  - Standard parity: the unchanged `apps/web/test/signal-rules.test.ts` passes against the engine.
- **Migration ordering:** Drizzle skips a migration whose journal `when` is at or below the last applied one. 0017's `when` is set above 0016's. If 0017 reaches production before #50 merges, #50's migration has to be renumbered (now 0019, since slice 2 takes 0018) with a newer `when`, or it will be skipped silently.

### 5. Incidents (slice 1)
- `alerts` gains `member_id`, `status` (`open|acknowledged|resolved|false_positive`, default `open`), `signal_ids uuid[]`, `eve_session_id` and `resolved_at`.
- **Backfill:**
  - `status` is `acknowledged` where `acknowledged_at` is set, otherwise `open`.
  - `member_id` comes through `subject_user_id`.
- Acknowledging sets both `acknowledged_at` and `status`. Existing routes and the dashboard keep working.
- A correlated decision appends signal IDs to an open alert with the same dedupe key and doesn't create a second one.
- `incident_actions` is created in slice 1 and used in slice 4.

### 6. Outbox and recipients (slice 2)
- `notification_outbox` per contracts, `channel = 'email'`. The writer inserts the outbox rows in the same transaction as the alert, one per recipient.
- **Recipients for an alert about member M:**
  - Owners, filtered by their `alert_email_threshold`, as today.
  - Plus M's helpers (`helper_member_ids`) when the severity is at or above M's `notify.helpersNotifyAt`. A helper with an account uses their account email; a helper without one uses their decrypted `contact`.
  - Recipients are deduped by address.
  - An Elder or Child member is never emailed about themselves, even if they are an owner. This self-exclusion applies only to those modes: a Standard-mode owner still gets alerts about their own devices, as today.
- The idempotency key is `alert:<alertId>:<recipientMemberId>`. For owners and members with an account, the Resend idempotency key stays `alert:<alertId>:<userId>`, so moving off `alert-created` can't double-send.
- **Drain:** the `alert-created` Inngest function keeps its id (so in-flight events are not orphaned) and drains the outbox, triggered by the same event, plus a 5-minute Inngest cron sweep for rows past their lease.
  - It claims rows with `UPDATE … SET lease_until = now() + 2 min … WHERE sent_at IS NULL AND (lease_until IS NULL OR lease_until < now()) RETURNING`, sends, and sets `sent_at`/`provider_id`.
  - After 5 attempts it sets `last_error` and marks the alert `email_status = failed`. A permanent 4xx sets attempts to 5 at once. An alert with no rows (raised before this deploy) is enqueued by the function first.
  - The sweep finds households with sendable rows through migration **0018** `list_outbox_tenants(max_attempts, page_limit)` (SECURITY DEFINER, tenant ids only, EXECUTE granted to `app_user`), then drains each household in its own tenant context.
  - It moves to an eve schedule in M3 with the other crons.
- The daily cap stays at 20 per tenant. It counts alerts, not emails: other alerts created that UTC day with `email_status` `pending` or `sent`, decided at enqueue under a per-tenant advisory lock (counting at send would let a burst pass before the first drain). **Critical alerts are exempt** from the cap. The cap notice is otherwise unchanged (same per-owner key, now an `alert_cap` outbox row, `ON CONFLICT DO NOTHING`).
- Templates come from `renderAlertEmail`. A helper email names the member ("Mum's laptop") and says "stop, hang up, call them" first.

### 7. eve agent (slice 3)
- Merge the spike (`apps/web/agent/`, `withEve`, `/eve/v1/*`).
- **Replace the HTTP self-call with an in-process lookup.** The channel `AuthFn` resolves the Auth.js session cookie and `neo_dt_` bearer tokens directly against the DB with the same code as `getSession()`, factored so it doesn't need Next's request scope.
  - This removes `NEO_APP_ORIGIN` and the Deployment Protection problem.
  - `/api/eve-session` is deleted.
- **Read-only tools:** `analyze_url`, `analyze_email`, `analyze_sms`, `get_incident`, `list_incidents`, `device_timeline` (a member's signals over the last 24 h, minimized) and `list_members`.
  - The tenant comes from the caller's attributes only.
  - DB access goes through `tenantScoped()`.
  - Results pass through `wrapToolResult`.
  - An ID from another tenant returns `not_found`.
- **Incident chat:** the alert email and the dashboard link to `/chat-v2?incident=<id>`, which starts a session seeded with `get_incident`. `eve_session_id` is stored on the alert.
- `/chat-v2` is gated by the env flag `NEO_EVE_CHAT` (unset means off; add it to `.env.example`). `/api/agent` is untouched.
- Instructions follow Elder tone: short sentences, "stop and hang up" first, no shaming, and never ask the elder to install anything.

### 8. Console and acting tools (slice 4)
- `/settings/household/members/[id]` (owners only) holds the display name, role, mode picker, helper picker (other members), helper contact email for helpers without accounts, and notify thresholds.
  - Changes write a `policies` row and audit `member.mode_changed` / `member.policy_changed`.
  - Turning Elder mode off emails every owner (templated).
- A shared `requireHouseholdAdmin(session)` replaces the inline `role !== "owner"` checks in new code. Existing routes adopt it as they are touched.
- **Acting tools, each `always()` approval plus `requireHouseholdAdmin` on the server at execution time:**
  - `mark_expected`: adds the tool and peer to `device_expected_tools` and resolves the incident as `false_positive`.
  - `allow_once`: resolves the incident with no policy change and records the decision.
  
  Both write `incident_actions` and an audit row.
- **Not in M1:** `block_site` and `end_session`. They need policy bundles (M2), and the "elder autonomy" question is still open.

## Possible Edge Cases
- **Engine and enrichment disagree:** the second evaluation applies. Enrichment can raise an escalated signal to an alert or dismiss it, but it never lowers an alert that a correlation rule already raised.
- **A member's mode changes while an incident is open:** the open incident keeps its severity, and new signals use the new mode.
- **A helper is also an owner:** one email, deduped by address.
- **An elder has no helpers:** owners only. The console warns on the member page.
- **The offline sweep and an uninstall beacon arrive for the same device:** both use dedupe key `protection_disabled:<deviceId>:<hour>`, so one alert.
- **The outbox row is written but the drain is down:** the cron sweep picks it up, and the lease prevents a double send.
- **A Resend 4xx (bad address):** no retry. Mark the outbox row failed and audit it.
- **The last owner tries to set their own mode to non-standard or demote themselves:** 409.
- **A signal for a device whose `member_id` is still null mid-rollout:** resolve the member through `user_id`.

## Acceptance Criteria
- After 0017, every membership has exactly one member, every device and code has a `member_id`, and alert statuses match `acknowledged_at`.
- For a Standard member, every existing signal test passes unchanged, with identical severities, kinds and dedupe keys.
- For an Elder member, rules 1, 2, 3 and 5 raise the specified alert, and rule 4 fires in unit tests.
- A critical alert for an elder emails each helper and owner exactly once. A replayed drain and an overlapping cron send nothing extra.
- `/chat-v2?incident=<id>` (flag on) explains the incident from `get_incident`. A signed-in chat works on a production deployment.
- `mark_expected` and `allow_once` require approval and an admin. A member (non-owner) approving gets 403 server-side.
- `docs/contracts.md` and `_specs/v2-architecture.md` match this spec. Each slice updates contracts before its code.

## Open Questions
- Elder autonomy: may a helper block a site on the elder's device mid-scam without the elder confirming? This blocks `block_site` (M2).
- Should a helper without an account get a magic-link sign-in so they can use the incident chat, or email only?
- Is the critical exemption from the 20-a-day email cap right? Recommended, since critical alerts are rare and must arrive.

## Testing Guidelines
Create test files in `./test` (per package), covering at least:
- **Policy engine:**
  - Each Elder rule fires and doesn't fire, including window edges.
  - Standard parity for every existing detector case.
  - `effectivePolicy` merge order and dropping unknown keys.
  - Enrichment re-evaluation.
- **Migration:** apply 0017 to a copy of the schema with sample memberships, devices, alerts. Check the backfill counts and that RLS isolates `members`.
- **Outbox:**
  - The recipient set (owners by threshold, helpers by mode threshold, self excluded, deduped).
  - Lease claim under concurrency.
  - Retry and give-up.
  - Idempotency keys unchanged for owners.
- **eve tools:**
  - The tenant comes from the caller only (a foreign alert ID gives `not_found`).
  - `wrapToolResult` is applied.
  - Acting tools reject non-admins.
