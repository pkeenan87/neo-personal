# Deferred roadmap items: digest, breach monitoring, hardening score, sign-in alerts, Outlook, mobile

Status: planned 2026-10-04. Parent plan: `phase-0-and-roadmap.md` §5 (Phase 2 and Phase 3 items that were never built).

**Executor:** Hermes agent running ChatGPT Luna 6 at maximum reasoning effort. This file is written for that agent. It
does not load `CLAUDE.md` or any memory files, so everything it must know about this repository is restated below.
Where this file and `CLAUDE.md` disagree, `CLAUDE.md` wins; tell the owner about the conflict.

## Context

Neo (`pkeenan87/neo-personal`, live at https://www.neoshield.dev) is an open source (MIT), multi-tenant personal
security agent. A tenant is a household; it has one owner and members. Phases 0–3 shipped:

- URL, email and SMS analysis
- forward-to-address intake
- dashboard and playbooks
- model routing through Vercel AI Gateway
- household invites and owner alerts
- device enrollment and signals
- the browser extension, and the Windows and macOS agents

The roadmap also listed six items that were never built. Phase 2 became model routing only, and two items from
Phase 3 were dropped:

| # | Item | Roadmap phase | Blocked on the owner? |
|---|------|---------------|-----------------------|
| 1 | Weekly digest email | 3 | No |
| 2 | Breach monitoring via Have I Been Pwned (HIBP), with a weekly re-check | 2 | API key (build with mock mode first) |
| 3 | Account-hardening checklist and score on the dashboard | 3 | No |
| 4 | Sign-in alert parser: Google, Microsoft, Apple, Meta, Amazon, PayPal | 2 | Geolocation provider (build with mock mode first) |
| 5 | Outlook.com connector: forwarding-rule audit, plus feeding sign-in alerts into step 4 | 2 | Azure app registration (build with mock mode first) |
| 6 | Expo mobile app | 2 | Yes: Apple and Google developer accounts. **Plan and spec only.** |

Do the steps in that order. Each step is one branch and one pull request (PR), and each can ship on its own. Steps 1–3
do not depend on each other. Step 5 feeds step 4, so do step 4 first.

## Decisions

- **Deterministic first.** Parsers, rules and scores are plain code with tests. The model is used only where the
  existing email verdict pipeline already uses it.
- **Signals, not surveillance** (the rule from Phase 3). The owner sees alerts, scores and summaries for members,
  never their mail, breach details beyond the breach name, or individual checklist answers. The spec for each step
  states exactly what the owner can see.
- **Read-only connectors.** The Outlook connector requests read scopes only. Removing a rule is a Phase 4 action
  tool that will need a confirmation gate; it is not part of this plan.
- **Mock mode for everything external.** With `MOCK_MODE=true` and no keys, every feature works with fixtures.
  Production keys are the owner's job.
- **Extend; don't fork.** Sign-in alerts arrive as email. Today the generic email verdict pipeline classifies them
  (`packages/tools/src/email/tool.ts`; see the "Legitimate notices … security alerts" guidance in the tool
  description). Step 4 adds structured, deterministic evidence to that pipeline. It does not build a second email
  path.

## Repository rules (mandatory)

1. **Spec before code.** Copy `_specs/template.md` to `_specs/<feature>.md` and fill it in: functional requirements,
   edge cases, acceptance criteria, open questions, testing. Recent specs to copy the style of are
   `_specs/owner-alerts.md`, `_specs/signals.md` and `_specs/device-enrollment.md`.
2. **Contracts before interfaces.** `docs/contracts.md` is authoritative. Add a section for each new package export,
   DB table or HTTP route *before* writing that code, then add an "As built" note for any difference.
3. **Tenant scoping.** Every DB query on a tenant table goes through `tenantScoped()`
   (`packages/db/src/tenant.ts`). Never query a tenant table without `tenant_id`. New tables get row-level security
   (RLS) and grants for the app role `app_user`; copy the pattern in the latest migrations under
   `packages/db/drizzle/`.
4. **Untrusted input.** Every tool result and every user-supplied artifact (email, SMS, web page, breach data, Graph
   response) is attacker-controlled. It reaches the model only through `wrapToolResult`
   (`packages/core/src/injection-guard.ts`). Never fetch a URL found in an email.
5. **Secrets.**
   - Never commit a secret.
   - Synthetic test secrets live only under `test/fixtures/`.
   - `gitleaks` (`.gitleaks.toml`) runs in CI and blocks the merge.
6. **Environment variables.**
   - Add every new variable to `.env.example` with a comment.
   - The code must work when the variable is unset: fall back to mock mode, or turn the feature off with a clear
     message.
   - Parse variables in `apps/web/lib/env.ts`.
7. **Dev auth bypass.** `DEV_AUTH_BYPASS` must stay ignored when `NODE_ENV=production` or `VERCEL_ENV` is
   `production` or `preview`.
8. **Auth for credential flows.** Anything that mints a token, approves a token or connects an account needs a
   browser session (`requireBrowserApiSession`). Device tokens (`neo_dt_`) must not reach these routes.
9. **GitHub Actions.**
   - Pin every action to a SHA, with the version in a comment.
   - Resolve SHAs with `gh api repos/{owner}/{repo}/git/refs/tags/{tag}`; for an annotated tag, dereference it via
     `git/tags/{sha}`. Never guess a SHA.
10. **Commits.**
    - Format: `<emoji> <type>(<scope>): <summary>`, using ✨ feat · 🐛 fix · 🔒 security · 📝 docs · 🧪 test ·
      ⬆️ deps.
    - End each message with this trailer: `Co-Authored-By: <TODO: owner to supply Hermes/Luna attribution>`.
    - Never commit directly to `main`.
11. **Privacy page.** Any feature that stores new personal data, or sends any to a new third party, updates
    `apps/web/app/privacy/page.tsx` and its test `apps/web/test/privacy-page.test.tsx` in the same PR.

## How to work each step

1. **Branch.** Run `git switch main && git pull`, then `git switch -c hermes/feature/<feature>`.
2. **Read** the reuse pointers listed under the step before designing anything.
3. **Check external APIs.** Confirm the current documentation for every API the step uses (HIBP, Microsoft Graph,
   Expo, Auth.js). The details in this plan may be stale. Record what you confirmed, and the date, in the spec's
   "Verified before implementation" section, as `_specs/desktop-agent-macos.md` does.
4. **Write the spec and the contracts change.** Commit them as the first commit on the branch.
5. **Spec review checkpoint: ON.** Push the branch, open a **draft** PR, and stop. Ask the owner to approve the spec,
   and answer the spec's open questions with them. Continue only after they approve. (The owner may edit this line
   to OFF.)
6. **Implement**, with tests next to the existing ones:
   - `apps/web/test/` (Vitest)
   - `packages/db/test/` (PGlite, running as `app_user`, so RLS is exercised)
   - `packages/tools/test/`
   - `packages/core/test/`
7. **Migrations.**
   - The next number is `0012`, and they are additive only.
   - Generate with `pnpm db:generate`, then hand-check the SQL for RLS and `app_user` grants.
   - Test locally against PGlite or a local Postgres (see `docs/development.md`).
   - **Never connect to the production database.** The owner applies production migrations before merging.
8. **Verify locally.** All of these must pass:
   ```sh
   MOCK_MODE=true pnpm turbo run typecheck lint test build
   ```
   - For any UI change, also run the app with `pnpm --filter @neo/web dev`, in mock mode with `DEV_AUTH_BYPASS=true`,
     and check the page.
   - If `VERCEL_ENV` or `DATABASE_URL` is set in your shell, unset both first. The Vercel tooling injects
     production values.
9. **Push and mark the PR ready.**
   - The PR body lists: what changed; whether there is a migration, in bold with its file name; new env vars;
     anything the owner must do; and what you could not verify.
   - End the body with a line naming the agent and model.
10. **CI.**
    - Branch protection requires the single **All checks passed** job.
    - The desktop jobs (`Desktop agent …` for Linux, Windows and macOS) run on every PR and take up to 25 minutes.
      They exit early when `apps/desktop` is unchanged, so slow is expected; it is not a failure.
    - Fix any red job. If the same failure comes back after two fixes, stop and report it with the log excerpt.
11. **Do not merge.** The owner merges. After the owner merges, start the next step from a fresh `main`.

## Stop and ask the owner

Stop when any of these happens:

- A step needs a paid account, a key, an app registration, a DNS change or a store listing.
- A spec has an open question about privacy or about what the owner sees for a member.
- A change would touch authentication, token minting, RLS policies outside the new tables, or `vercel.json`.
- An existing test would need to be weakened or deleted to pass.
- Anything would require production access.

## Steps

### 1. Weekly digest email

Spec `_specs/weekly-digest.md`.

- **Schedule.** An Inngest cron function, weekly on Monday at 14:00 UTC.
- **Recipients.** One email per user who has opted in. Default: on for owners, off for members.
- **Content for the user:**
  - the past 7 days' verdicts, counted by label
  - the top 3 riskiest items, as links into the dashboard
- **Owner-only content:**
  - alerts raised for members, as counts by severity, with the top items linked
  - device health: devices offline or uninstalled
- **Later steps.** Leave clearly marked slots for the breach status (step 2) and the hardening score (step 3).
  Render them only when those features exist.
- **Empty weeks.** Skip a week with nothing to report. Do not send "nothing happened" mail.
- **Idempotency.** Use the key `digest:<userId>:<ISO week>`, so retries never send twice.
- **Unsubscribe.**
  - A toggle in Settings.
  - A one-click unsubscribe link signed with an HMAC. The key is derived from `AUTH_SECRET` with its own label; copy
    the pattern in `apps/web/lib/server/uninstall.ts`.
  - The `List-Unsubscribe` and `List-Unsubscribe-Post` headers.
- **Privacy.** No email bodies or URLs from verdicts appear in the digest, only the titles the dashboard already
  shows.
- **Reuse:**
  - cron pattern: `apps/web/inngest/functions/artifacts-expire.ts`, `devices-offline.ts`, and the function
    registry `apps/web/inngest/functions/index.ts`
  - email: `apps/web/lib/server/email/{resend,alert-email,verdict-email}.ts`
  - alerts: `apps/web/lib/server/alerts/`
  - in-memory stores used when there is no DB: `apps/web/lib/server/memory-*.ts`
- **Tests:**
  - content selection: owner versus member, and an empty week
  - idempotency
  - the signed link: valid, tampered, and for the wrong user
  - opt-out
  - an HTML snapshot

### 2. HIBP breach monitoring

Spec `_specs/breach-monitoring.md`.

- **Which addresses.**
  - Monitor only addresses whose ownership is verified: the sign-in email when Google's `email_verified` claim is
    true, plus extra addresses confirmed through an emailed link.
  - Never query an address the user has not proven they own.
- **Weekly re-check.**
  - An Inngest cron function fans out one event per address.
  - Use Inngest `throttle` or `concurrency` to stay inside the HIBP plan's rate limit. Read the limit from an env
    var.
  - Check the current HIBP API v3 docs for the `breachedaccount` endpoint, the `hibp-api-key` and `user-agent`
    headers, and the 404 meaning "not found".
- **What to store.**
  - Store breach names and dates already seen per address, so only *new* breaches alert.
  - Never store passwords or pastes.
  - Store extra monitored addresses encrypted, or hashed plus encrypted, using `deriveTenantKey` and
    `encryptArtifact` from `packages/core/src/artifact-crypto.ts`.
- **Alerts.**
  - A new breach raises an alert for the address's user through the existing alerts module, with severity by the
    breach's data classes. Passwords: `high`. Otherwise: `medium`.
  - Each alert links to a short static checklist (change the password, turn on 2FA). Do not have the model write
    this guidance.
  - Whether the owner sees members' breach alerts is an open question for the owner. Default to "breach name only,
    no address".
- **Chat.** Add a tool so "Have I been in a breach?" gets a truthful answer from stored results. Wrap its result with
  `wrapToolResult`.
- **Mock mode.** With `HIBP_API_KEY` unset, return fixture breaches for addresses ending in `@example.com`, and none
  for any other address.
- **Privacy page.** Add a paragraph: addresses are sent to HIBP, and how often.
- **Owner prerequisite.** An HIBP API subscription. Build and ship in mock mode, and list the env vars in the PR.

### 3. Account-hardening checklist and score

Spec `_specs/hardening-score.md`.

- **The checklist.** A fixed, versioned checklist in code. No model.
- **Self-attested items** (each links to the provider's own official help page; no scraping):
  - 2FA on the primary email account
  - a passkey or hardware key
  - recovery phone and email are current
  - a password manager
  - a carrier port-out PIN
  - a credit freeze
  - OS and browser auto-update
- **Items detected from Neo's own data:**
  - forward-to-address used in the last 30 days
  - browser extension enrolled
  - desktop agent enrolled
  - no unresolved breach (once step 2 ships)
- **Score.** A weighted percentage plus the next 3 actions. Show both on a dashboard card, with the full checklist
  in Settings.
- **Storage.** Store answers per user, with `answered_at` and the checklist version. Show an answer as stale after
  180 days.
- **Owner view.** The owner sees each member's score and the number of open items, not the individual answers.
  Confirm this with the owner in the spec.
- **Reuse:**
  - dashboard components under `apps/web/components/`
  - the existing dashboard tests (`apps/web/test/dashboard.test.tsx`)
- **Tests:**
  - score math, including weights and stale answers
  - version migration (a new item added)
  - what the owner versus a member can see
  - UI render

### 4. Sign-in alert parser and "review my sign-ins"

Spec `_specs/signin-alerts.md`. Read `_specs/email-analysis.md` and `packages/tools/src/email/` first.

- **Parser** (`packages/tools`, e.g. `src/signin/`):
  - A deterministic parser for alert emails from Google, Microsoft, Apple, Meta, Amazon and PayPal.
  - It extracts: provider; event (new sign-in, new device, password changed, 2FA or recovery changed, suspicious
    activity); device or app; coarse location; IP; time.
  - Unknown templates return `null` and fall back to today's behaviour.
- **Fake-alert detection.** Mark a message a likely fake when any of these hold:
  - the visible provider does not match the sender domain with DKIM and DMARC alignment
    (`packages/tools/src/email/auth.ts` already parses authentication results)
  - links point outside the provider's known domains
  - it has a callback phone number
  - it asks for a reply with codes
- **Pipeline integration.** Parser output becomes structured evidence in the existing email verdict tool result,
  passed through `wrapToolResult`. Deterministic rules take priority over the model's verdict:
  - fake alert → `malicious`
  - genuine alert → the email is `likely_safe`, and the user is asked "Was this you?"
- **Known devices.**
  - Store parsed sign-in events per user: provider, event, a device label, coarse location, time.
  - The first time a provider and device pair is seen, ask "Was this you?" with Yes / No buttons on the verdict.
  - "No" opens a playbook. None covers account takeover today (`apps/web/lib/server/playbooks/` has `entered_password`, `shared_code`, `device_compromised` and others), so the spec either adds an `account_takeover` playbook or reuses `entered_password`.
  - "Yes" remembers the device.
- **IP geolocation.**
  - Define an interface with a mock and one adapter.
  - Which provider (MaxMind GeoLite2 local database versus a hosted API) is an owner decision. Default: mock only
    until the owner decides.
  - The IP comes from attacker-controlled mail, so location is advisory and is labelled so in the UI.
- **Chat.** Add a tool so "Review my sign-ins" lists the stored events with known-device status. This is the
  roadmap's Phase 2 exit: "review my sign-ins" has a truthful answer.
- **Fixtures.**
  - Synthetic only, built from each provider's public documentation and screenshots. Never commit real mail.
  - Mark every template `verified: false` until the owner forwards a real alert and confirms it parses, using the
    same convention as the desktop session evidence.
- **Tests:**
  - per-provider parse
  - unknown template → `null`
  - each fake-alert rule
  - deterministic precedence over the model verdict
  - the known-device flow
  - the chat tool's output is wrapped

### 5. Outlook.com connector

Spec `_specs/outlook-connector.md`. Check the current Microsoft identity platform and Graph documentation first, and
record the results in the spec.

- **OAuth.**
  - A connector in Settings. It is **not** a sign-in provider.
  - Authorization-code flow with PKCE and `state`, for personal Microsoft accounts.
  - Scopes: read-only, the minimum needed. Expected: `offline_access`, `User.Read`, `Mail.Read`,
    `MailboxSettings.Read`. Confirm each one.
  - Start and callback routes require `requireBrowserApiSession`.
- **Tokens.**
  - Encrypt refresh and access tokens with `deriveTenantKey` / `encryptArtifact`. The additional authenticated data
    (AAD) binds tenant, user and connector id.
  - Refresh them on use.
  - "Disconnect" deletes the tokens and revokes them where Graph allows it.
- **Forwarding audit.**
  - Read inbox message rules and flag any that forward, redirect or forward-as-attachment to an external address.
  - Check, and document, whether Graph exposes account-level SMTP forwarding for consumer accounts. If it does not,
    say so in the UI.
  - Findings raise alerts: forwarding to an external address is `high`.
  - Run the audit on connect, then daily from Inngest.
- **Sign-in alerts.**
  - Every 15 minutes, poll the inbox with a delta query.
  - Fetch full content only for messages from the known alert sender addresses of the step 4 providers.
  - Feed those messages into the step 4 parser. Store only parsed events; message bodies follow existing artifact
    retention.
  - Webhook subscriptions are out of scope: they need renewal and add attack surface.
- **Mock mode.** A fake Graph client with fixture rules and messages.
- **Privacy page.** Which scopes Neo uses, what it reads, what it stores, and how to disconnect.
- **Owner prerequisites:**
  - an Azure app registration (personal accounts) with redirect URI
    `https://www.neoshield.dev/api/connectors/outlook/callback`
  - the client ID and secret added to Vercel env
  - possibly Microsoft publisher verification
- **Tests:**
  - the OAuth state and PKCE checks
  - the token encryption round trip, and that the wrong tenant fails to decrypt
  - rule classification: internal, external, disabled
  - the delta cursor
  - the sender allowlist
  - disconnect

### 6. Expo mobile app: plan and spec only

Do **not** scaffold code. Write `_plans/mobile-app.md` and `_specs/mobile-app.md`, covering:

- **Workspace.** An Expo app in `apps/mobile`, inside the pnpm and Turborepo workspace.
- **Auth.**
  - Sign in through a device-authorization browser flow, reusing `_specs/desktop-auth.md` and scoped `neo_dt_`
    tokens.
  - Apple Sign In and passkeys added to Auth.js. App Store review expects Apple Sign In when Google sign-in is
    offered.
- **Features:**
  - chat
  - share-sheet intake for messages, links and screenshots
  - QR scanning: decode only, then send the URL through URL analysis
  - push notifications for verdicts and owner alerts
- **Release.** EAS Build, TestFlight and the Play internal track.
- **Owner prerequisites:** the Apple Developer Program, a Google Play Console account and an Expo account.
- **Open questions** for the owner.

Open a docs-only PR and stop.

## Exit

- All of the following work in mock mode in CI:
  - a weekly digest arrives with correct content
  - breach monitoring alerts on a new fixture breach
  - the dashboard shows a hardening score
  - a forwarded fixture Google sign-in alert yields a "Was this you?" verdict, and a spoofed one is `malicious`
  - a fixture Outlook mailbox with an external forwarding rule raises a `high` alert
- The mobile plan and spec are approved by the owner.
- Live verification (real HIBP key, real alerts, a real Outlook account) is listed in each PR as owner follow-up.
  It is not claimed as done.

## Out of scope

- Write scopes or remediation: removing rules or blocking senders (Phase 4 action tools)
- Gmail or iCloud connectors
- Graph webhook subscriptions
- Pwned Passwords checks
- Paid tier and Stripe
- Safari and iOS SMS filtering
- Building the mobile app
