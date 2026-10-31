# Spec for v2-architecture

branch: claude/feature/v2-architecture
plan: `_plans/v2.md` (M0, items 3 and 5); design source: Notion "Neo personal v2 redesign plan" (2026-10-31)
status: draft. eve spike (`claude/spike/eve`, 2026-10-31): **local GO; deploy GO pending a preview deployment** (§1).

## Summary

Neo v2 adds per-member protection modes (Standard, Child, Elder), a deterministic policy engine that turns device signals into incidents, an outbox for notifications that must not wait on the model, and an eve agent for chat and proactive follow-up. Desktop and extension agents stay; their contracts change only by additions. v2 is built **on the live schema** (migrations 0001–0015 on Neon); nothing is dropped and recreated.

This spec records the architecture decisions M1–M3 build on. Each milestone gets its own feature spec.

## Owner decisions (2026-10-31)

- **Audience:** Patrick's own household and family first. Consent and notice flows are present but light; COPPA verifiable-consent work is deferred until outside households join (it becomes a gate for that, recorded in `SECURITY.md`).
- **Critical alert channel:** email (Resend, already live) in M1. More channels come later, and members should be able to connect their own (§4).
- **Parked:** the hardening score (#48) stays in the code and its settings page, but is not carried into the v2 console or the eve agent. Sign-in alerts, forward-to intake, breach monitoring and the Outlook connector (#50) carry over.

## Functional requirements

### 1. Deploy layout (pending spike)
- Vercel Root Directory stays `apps/web` unless the spike shows eve cannot run there.
- One Vercel project (`neo`), one production domain (www.neoshield.dev).
- The repo-root `vercel.json` is not read by Vercel (Root Directory is `apps/web`); delete it unless the layout needs a root config.
- **Decision (spike, 2026-10-31): Next.js hosts the agent.** The agent lives in `apps/web/agent/` and `apps/web/next.config.ts` wraps the config in `withEve` from `eve/next`. eve runs as its own server beside Next and is reached through `/eve/v1/*` rewrites on the same origin. Root Directory stays `apps/web`; no root `vercel.ts` and no Vercel Services. (eve's docs recommend Services for new projects and Next hosting "when you add an agent to an existing Next.js app"; `node_modules/eve/docs/guides/frontend/nextjs.mdx`.) `next start` runs both, which keeps self-hosting working.
- On Vercel, eve builds into the same deployment. Vercel configures Workflow (session storage and resume), Cron (schedules) and Sandbox from the build output; AI Gateway authenticates through project OIDC, so no new integration or API key (`guides/deployment/vercel.mdx`). Self-hosters need a Workflow world (Postgres world, `@workflow/world-postgres`) — document in `docs/self-hosting.md`.
- **Version pin:** `eve` exactly `1.0.0-rc.1` with an exact `minimumReleaseAgeExclude` entry. On Vercel Workflow, a session started on one eve version stays answerable after an upgrade (per-deployment routing); on self-hosted worlds any eve upgrade strands open sessions (`concepts/execution-model-and-durability.mdx`, "Stranded sessions"). Move to GA when it ships and pin exact versions from then on.
- **Auth hop:** eve runs outside Next's request scope, so `getSession()` can't run in the agent. The eve channel's `AuthFn` forwards the caller's `cookie` / `Authorization` to `GET /api/eve-session` on a fixed origin (`NEO_APP_ORIGIN`, never from the request) and maps the result to the eve caller (`principalId` = user, `attributes.tenantId`). `localDev()` stays last in the walk; it only accepts requests on a local dev server. Before production: set `NEO_APP_ORIGIN` per environment, and check that Deployment Protection on previews doesn't block the self-call (it fails closed with a 401). M1 should consider resolving the Auth.js session and `neo_dt_` tokens in-process instead of over HTTP.
- **Verified locally:** typecheck, lint, all tests and `next build` pass; under `next dev` a mock-mode chat calls `analyze_url` end to end; in a production build (`eve build` + `next start`) an anonymous request and a forged `neo_dt_` bearer both get 401 from `/eve/v1/session`, and `DEV_AUTH_BYPASS` is ignored.
- **Build step:** `next build` alone does not build the agent; `next start` refuses to run without `apps/web/.output/` from `eve build`. Self-hosting needs `eve build && next build`. Whether a Vercel build runs `eve build` itself under `withEve` is not documented for a Root Directory of `apps/web`.
- **The preview deployment must prove:** the build succeeds with the current build command (or with `eve build` added); `/eve/v1/health` answers; Vercel Workflow appears on the deployment; and the project's plan allows Workflow and Cron. A 401 from chat on a protected preview (the `/api/eve-session` self-call hitting Deployment Protection) is expected and is not a NO-GO.
- `apps/web/.eve/` and `apps/web/.output/` are build output (gitignored and ESLint-ignored). The stale repo-root `vercel.json` is deleted on `claude/chore/v2-m0`.

### 2. Members and modes (M1)
- Today a household member is a `memberships` row, which requires a signed-in `users` row, and `devices.user_id` points at that user. A child or an elder may never sign in, so v2 adds a `members` table: `id`, `tenant_id`, `user_id` (nullable, unique per tenant), `display_name`, `role` (`owner | adult | child | elder`), `mode` (`standard | child | elder`), `birth_year` (child only, optional), `helper_member_ids` (elder), `contact` (encrypted; email now, phone later), timestamps. Tenant RLS, in `tenantTables`, granted to `app_user`.
- Migration backfills one `members` row per `memberships` row (`role`: `owner` stays `owner`, `member` → `adult`; `mode: standard`).
- `devices` gains `member_id` (backfilled from `user_id`); `user_id` becomes nullable in a later migration once every read goes through `member_id`. New devices enrolled for a member without an account carry only `member_id`.
- Enrollment codes target a member (`member_id`), not only a user.
- `memberships` stays the authorization record for people who sign in; only owners (and adults the owner promotes) are admins.

### 3. Policy, incidents and the outbox (M1)
- `policies`: `tenant_id`, `scope` (`household | member | device`), `scope_id`, `version`, `rules` jsonb (validated by a zod schema in `@neo/verdict`), `created_by`, `created_at`. The append-only versions give history. The **effective policy** for a device is household → mode defaults (code constants, not a table) → member → device.
- **Policy engine:** pure TypeScript in `packages/core` (`evaluateSignal(effectivePolicy, signal, recentSignals) → Decision`), no I/O and no model, fully unit-tested. It runs inline in `POST /api/signals` after insert and replaces the correlation and severity logic now in the `signal-escalate` Inngest function. A model-written verdict is still produced afterwards for the explanation, but it can no longer raise or lower severity.
- **Incidents extend `alerts`** instead of adding a parallel table: `alerts` already has kind, severity, dedupe key, subject user, device, acknowledgement and email status. v2 adds `member_id`, `status` (`open | acknowledged | resolved | false_positive`, backfilled from `acknowledged_at`), `signal_ids uuid[]`, `eve_session_id`, `resolved_at`. Existing alert routes keep working; the console reads the same rows.
- `incident_actions`: `alert_id`, `kind` (`mark_expected | allow_once | block_site | end_session | extend_time | …`), `requested_by` (`agent | admin`), `approved_by`, `status`, `result`, timestamps.
- `notification_outbox`: `tenant_id`, `idempotency_key` (unique), `channel` (`email` now), `destination`, `template`, `payload` jsonb (minimized), `attempts`, `lease_until`, `sent_at`, `provider_id`, `last_error`. Writers insert in the same transaction as the incident. The `alert-created` email path moves onto it; the Resend idempotency keys stay the same (`alert:<alertId>:<userId>`) so the switch can't double-send.
- Critical alerts are rendered from templates only; the model never writes their text.

### 4. Agent and channels (M1 web chat; more later; pending spike)
- One eve agent ("Neo"). Every tool resolves the tenant from the verified session (`getSession()`), never from model output or the request body, and touches the DB only through `tenantScoped()`.
- Every tool result passes through `wrapToolResult` before the model sees it.
- Read-only tools first (`analyze_url`, `analyze_email`, `analyze_sms`, `get_incident`, `device_timeline`, `list_members`); acting tools (`mark_expected`, `allow_once`, `block_site`, `end_session`) use `always()` approval, and the server re-checks that the approver is an admin.
- Models follow `packages/core/src/routing.ts` through AI Gateway, with the same Haiku 4.5 restrictions.
- The existing chat (`/api/agent`) stays until the eve chat reaches parity (paste a link, playbooks, verdict cards, sign-in "Was this you?").
- **Channels eve ships:** the base HTTP channel (web chat via `useEveAgent`), Slack, Microsoft Teams, Discord, Telegram, Twilio (SMS and voice), Linear, GitHub, Linq and Photon (messaging), MCP, Chat SDK adapters, and custom `defineChannel` routes. A webhook or schedule can start a conversation on another channel (cross-channel hand-off), and eve posts sign-ins only where the person reads them alone.
- **Members connecting their own channel (later):** platform channels identify the caller by platform identity (Twilio: the phone number as `principalId`; Telegram: the `from` user). Add a `member_channels` table (`member_id`, `channel`, `platform_id`, `verified_at`): a member links a channel from the console with a one-time code sent over it, and that channel's `AuthFn` resolves only verified platform IDs to a member and tenant. Unknown senders get a fixed "not connected" reply and never reach the model. The outbox gains one `channel` value per connected channel.

### 5. Background work (M1–M3)
| Today (Inngest) | v2 | Milestone |
| --- | --- | --- |
| `signal-escalate` | policy engine inline on ingest; model explanation afterwards | M1 |
| `alert-created` | outbox row + drain schedule | M1 |
| `email-received` | keep the Resend webhook route; it calls the analyzers directly | M3 |
| `weekly-digest`, `devices-offline`, `breach-monitoring` | eve schedules, run in parallel with Inngest for one cycle, then Inngest removed | M3 |
| `artifacts-expire` | retention schedule; also purges signals and the outbox | M3 |

Inngest (functions, `/api/inngest`, the `inngest` dependency, its `vercel.json` entry, env vars and the Marketplace integration) is removed only after every row above has moved.

### 6. Device contract additions (M2; backward compatible)
- `POST /api/devices/heartbeat` response adds `policyVersion: string | null`. Clients that don't know it ignore it.
- New `GET /api/devices/policy` (scope `device` + `deviceId`): the device's compiled, signed policy bundle; `ETag: "<policyVersion>"`, 304 on match. Signed with a minisign key that is separate from the release-signing key and not stored in Vercel env.
- `member_id` is resolved server-side from the device token; clients never send it.
- New signal detectors (`web_blocked`, `app_installed`, `screen_time_exhausted`, `protection_disabled`, `payment_page`) are added to `SIGNAL_DETECTORS`; older servers reject unknown detectors as `invalid`, so clients must ship after the server.

## Possible Edge Cases
- A member without an account has devices but no `memberships` row: alerts about them go to the owner and their helpers, never to themselves by email.
- An owner demotes themselves or changes their own mode: blocked; at least one owner is always `standard`.
- Policy compiled while a device is offline: the device applies it on its next heartbeat; the console shows "pending on device".
- Outbox drain runs twice (overlapping cron, redeploy): the lease and the idempotency key keep it to one send.
- Engine and model disagree on severity: the engine wins; the model's verdict is shown as explanation only.
- A devices row with `user_id` set and `member_id` null during the rollout: reads fall back to the membership's member.

## Acceptance Criteria
- Decisions in §1 and §4 are filled in from the spike, and the go/no-go is recorded (done: GO).
- `docs/contracts.md` has a "Package contracts (v2, planned)" section that matches §2–§6.
- `CLAUDE.md` names the v2 plan and spec and the rules for eve tools.
- No production change in M0 beyond the cleanup in `_plans/v2.md` §3.

## Open Questions
- Child age bands (under 10, 10–13, teens) with different defaults?
- Enforcement depth: is the extension plus desktop agent enough for Child mode, or add DNS filtering? May the desktop agent act (kill a process, end a session) or only warn?
- Elder autonomy: can a helper block a site on an elder's device during an active scam without the elder confirming?
- Phones: ingest Screen Time or Family Link state later, or leave phones out?
- Monthly model spend cap per household?

## Testing Guidelines
M0 is docs plus the spike. Tests come with each milestone; for M1 at least:
- Policy engine: each of the 5 Elder rules fires and doesn't fire, dedupe windows, effective-policy merge order.
- Members backfill migration on a copy of the production schema (one member per membership, devices linked).
- Outbox: idempotent drain, lease expiry, no double send across the `alert-created` switch.
- eve tools: tenant from session only (a tool given another tenant's ID in input returns not found), `wrapToolResult` applied.
