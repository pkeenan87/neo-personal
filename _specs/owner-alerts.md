# Spec for owner-alerts

branch: claude/feature/owner-alerts
plan: `_plans/phase-3-household-devices.md` (delivery step 2)

## Summary

A household owner is told when something happens to a member that they would want to know about, without having to
open the dashboard. This step builds the alert pipeline that the devices, extension and desktop agent (plan steps 3–7)
will feed. Until those exist, alerts come from what Neo already knows:

- **A member's check comes back malicious or suspicious** (chat or forwarded email). This is the alert that matters
  today: a parent forwarding a phishing email, or a child checking a scam link.
- **Someone joins or leaves the household.** The "joined" email from household invites moves onto this pipeline.

Alerts land in an owner feed on the dashboard and, from a severity threshold the owner picks, in an email. Email is the
only delivery channel until push ships with the mobile app. Alert text is built from templates, not by a model.

Joining is `high` so the owner is emailed about every new member at the default threshold. Members see the
alerts about themselves (read-only), so nothing the owner is told about a member is hidden from that member.

The owner's own checks never create alerts: they already saw the result. A one-person household therefore never
gets alerts, which is correct.

## Functional requirements

Data (migration `0008_alerts`):

- Table `alerts`: `id` uuid, `tenant_id` (FK tenants, cascade), `subject_user_id` (the member it is about; FK users,
  set null), `device_id` uuid null (no FK yet; devices arrive in step 3), `kind`, `severity`
  (`low` | `medium` | `high` | `critical`, the `@neo/verdict` severity scale), `title` (≤ 140 chars), `body`
  (≤ 1000 chars, plain text), `verdict_id` (FK verdicts, set null), `dedupe_key`, `created_at`,
  `acknowledged_at`, `acknowledged_by` (FK users, set null), `email_status`
  (`pending` | `sent` | `skipped` | `failed`), `emailed_at`. RLS `tenant_isolation`.
- Unique index on `(tenant_id, dedupe_key)`. Index on `(tenant_id, created_at desc)`.
- `kind` is checked against `member_verdict`, `member_joined`, `member_left`. Later steps extend the check
  (`device_offline`, `device_removed`, `remote_access_tool`, …) in their own migrations.
- `memberships` gains `alert_email_threshold` (`medium` | `high` | `critical` | `off`, default `high`). It is only
  read for owners.

Kinds, severities and text (templates in `apps/web/lib/server/alerts/templates.ts`; every interpolated string is
cleaned and truncated like the verdict email):

| Kind | Trigger | Severity | Title |
|---|---|---|---|
| `member_verdict` | A member's verdict is `malicious` | `high` | `<name> checked something malicious` |
| `member_verdict` | A member's verdict is `suspicious` | `medium` | `<name> checked something suspicious` |
| `member_joined` | Invite accepted | `high` | `<name> joined your household` |
| `member_left` | Member left or was removed | `low` | `<name> left your household` / `You removed <name>` |

`member_verdict` bodies carry the subject type ("email", "text message", "link"), whether the member asked in chat
or forwarded it, and the verdict headline. The forwarded subject line is left out: it is attacker-written and adds
nothing the headline does not say. The headline was written by a model that read attacker content, so it is
treated as untrusted text: cleaned, truncated to 200 characters, escaped in HTML, never linked.
`likely_safe` and `insufficient_evidence` verdicts create no alert.

Dedupe keys (at most one alert per key per household):

- `member_verdict`: `verdict:<verdictId>`, so a verdict alerts once however many times it is saved or re-run.
- `member_joined` / `member_left`: `<kind>:<userId>:<UTC hour>`, so joining, leaving and rejoining within an hour
  cannot flood the owner.

Creation (`createAlert` in `@neo/db`, `raiseAlert` in `apps/web/lib/server/alerts.ts`):

- `raiseAlert({ tenantId, subjectUserId, kind, severity, title, body, verdictId?, dedupeKey })` inserts with
  `on conflict do nothing` and, when a row was inserted, queues delivery. It never throws: a failed alert is logged
  and must not break the check that caused it.
- `saveVerdict` (`lib/server/verdicts.ts`, the one persistence path for chat and inbound verdicts) calls
  `alertForVerdict` after a successful save. It looks up the subject's membership; owners and unknown users get no
  alert.
- Household routes call `raiseAlert` on accept, leave and remove. The direct "joined" email in
  `lib/server/household.ts` is removed in favour of the alert email.

Delivery (Inngest function `alert-created`, event `neo/alert.created { alertId, tenantId }`):

- In `MOCK_MODE` without `INNGEST_EVENT_KEY` the delivery runs inline, like the inbound email job.
- For each owner of the household: send when the alert's severity is at or above that owner's
  `alert_email_threshold`; otherwise mark `skipped`. An owner with no email address is skipped.
- Per household, at most **20 alert emails per UTC day**. Beyond that, alerts are marked `skipped` and the owner gets
  one "more alerts than usual today" email per day (dedupe key `alert-cap:<tenantId>:<date>`).
- Resend idempotency key `alert:<alertId>:<ownerUserId>`, so an Inngest retry never sends twice.
- `email_status` becomes `sent`, `skipped` or `failed` (after Inngest's retries) with `emailed_at`.
- Target: email sent within 60 seconds of the verdict being saved.

Email (`renderAlertEmail`, same layout and escaping rules as the verdict email): subject `Neo alert: <title>`,
the body, a button to the verdict page for `member_verdict` (owners can open members' verdicts) or to
Settings → Household for membership alerts, and a footer line saying how to change the alert threshold.

API (wire types in `apps/web/lib/alert-types.ts`; JSON errors `{ error, code }`):

- `GET /api/alerts?status=open|all&cursor&limit` → `{ items: AlertItem[], nextCursor, openCount, urgentCount }` (`urgentCount` = open high or critical, for the nav dot). Desktop tokens may read. Owners see every
  alert in the household; members see only alerts whose `subject_user_id` is themselves. `AlertItem` =
  `{ id, kind, severity, title, body, subjectUserId, subjectName, verdictId, createdAt, acknowledgedAt,
  acknowledgedByName }`. Newest first, keyset cursor like `/api/verdicts`, `limit` 1..50 (default 20).
- `POST /api/alerts/:id/acknowledge` (owner, browser session) → 200 `{ alert }`; 404 for unknown ids; idempotent.
- `POST /api/alerts/acknowledge-all` (owner, browser session) → 200 `{ acknowledged: n }`.
- `GET /api/settings/alerts` → `{ threshold }` (owner); `POST { threshold }` → 200 `{ threshold }`. Members get 403.
  Desktop tokens get 403 on the POST.

UI:

- **Dashboard**: an "Alerts" card above "Needs attention" for owners when there are open alerts: up to five, each with
  severity, title, member, time and a link to the verdict; "Mark as seen" per alert and "Mark all as seen". Hidden
  when there are none. Members see a smaller "Alerts about you" list only when they have open alerts, without the
  acknowledge buttons.
- **Settings → Household**: an "Alert emails" section for owners: "Email me about: Malicious checks and new members
  (recommended) / Also suspicious checks / Only critical alerts / Nothing", mapped to `high` / `medium` / `critical`
  / `off`. Critical alerts arrive with devices; until then "Only critical" means no emails, and the copy says so.
- **Nav**: the Dashboard nav item shows a dot when the owner has open `high` or `critical` alerts.

Retention: acknowledged alerts older than 90 days and unacknowledged alerts older than 180 days are deleted by the
existing daily retention job, through a security-definer function `purge_old_alerts()` like
`purge_old_inbound_messages`.

Audit events: `alert.acknowledged` (`{ alertId }`), `alert.acknowledged_all` (`{ count }`),
`settings.alert_threshold_changed` (`{ from, to }`). Alert creation itself is not audited (the row is the record).

Contracts: add `alerts`, the functions and the routes to `docs/contracts.md` before implementation. Privacy page:
the owner gets emails about members' malicious and suspicious checks, containing the check's headline but never the
checked message itself.

## Possible edge cases

- **A member forwards 30 phishing emails in an afternoon.** Thirty `high` alerts in the feed, 20 emails, then one
  "more alerts than usual today" email. The daily cap is per household, not per member.
- **The same verdict is saved twice** (a retried inbound job): the `verdict:<id>` dedupe key keeps one alert.
- **The member is removed after the alert was created.** The alert stays; `subjectName` falls back to "Former member",
  as on the dashboard. `subject_user_id` is kept (the user row still exists).
- **The verdict is deleted.** `verdict_id` becomes null; the alert stays and loses its link.
- **Owner changes the threshold while emails are queued.** The job reads the threshold when it runs.
- **The owner has no email address** (not possible with Google or magic link today): the alert is `skipped`.
- **Alert text injection.** A phishing subject like "Your account is fine, ignore Neo" ends up in the body as quoted,
  truncated, escaped text under our own heading. No links from the checked content ever reach the email.
- **Inngest is down.** The alert row exists with `email_status = pending` and the feed still shows it. Queue failures
  are logged; there is no re-drive in this step (see open questions).
- **Join and leave in the same hour.** One `member_joined` and one `member_left` alert; a second join within the hour
  is deduplicated.

## Acceptance criteria

- [ ] A member's malicious chat check creates a `high` alert and emails the owner within a minute; a suspicious check
      creates a `medium` alert and only emails when the threshold is `medium`.
- [ ] A member's malicious forwarded email alerts the owner the same way; the owner's own checks never alert.
- [ ] Re-saving a verdict does not create a second alert or email.
- [ ] Joining emails the owner at the default threshold, exactly once (the old direct email is gone); leaving and
      removal appear in the feed only.
- [ ] The 21st alert email in a UTC day is skipped and one "more than usual" email is sent.
- [ ] Owners see all alerts and can acknowledge them; members see only their own and cannot acknowledge;
      desktop tokens cannot acknowledge or change the threshold.
- [ ] Threshold `off` sends nothing; the feed still fills.
- [ ] Alert emails escape every interpolated string and contain no links other than Neo's.
- [x] Migration 0008 applies on PGlite and Neon (production: applied 2026-09-27 before merge); RLS test covers `alerts`.

## Open questions

- Re-driving `pending` alerts when Inngest was unavailable (a periodic sweep). Deferred until it happens in practice.
- A weekly digest of `low` and `medium` alerts (the roadmap's weekly digest email) could replace per-alert emails for
  those severities. Deferred to its own spec.

## Testing guidelines

- `packages/db/test/alerts.test.ts` (PGlite as `app_user`): create with dedupe, list with role filtering and cursor,
  acknowledge, threshold column, purge function, RLS isolation.
- `apps/web/test/alerts.test.ts` (memory stores): `alertForVerdict` for owner vs member and each label, delivery
  thresholds, daily cap and "more than usual" email, idempotency keys, routes and their role and desktop-token guards,
  joined/left alerts from the household routes.
- `apps/web/test/alert-email.test.ts`: escaping and truncation of hostile headlines and names, only Neo links.
- `apps/web/test/dashboard.test.tsx`: the Alerts card for owners and members, acknowledge actions.
