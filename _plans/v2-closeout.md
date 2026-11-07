# Neo v2 close-out: decisions, slices and the build loop

Status: planned 2026-11-07. Parent plans: `_plans/v2.md`, `_specs/v2-m3-cutover.md`, `_specs/v2-m4-hardening.md`, `_specs/v2-followups.md`.

The goal is to get every remaining v2 code item written in one unattended run, so the next day is for manual checks only. Claude drives the loop, the local Qwen model writes the code, and Claude reviews every line and runs the pipeline before anything is committed (the same pattern as `_specs/v2-followups.md`).

## 1. Owner decisions (2026-11-07)

These settle the open questions in the M3 and M4 specs. Slice 1 copies them into those specs.

| Question | Decision |
| --- | --- |
| `end_session`: should an adult skip the prompt on their own computer? | No. Everyone except a Child-mode member confirms on screen (no change). |
| A scammer at the mouse can click "Keep it" | No second channel. Record it in `SECURITY.md` as a residual risk. |
| Minute polling all day on an Elder's computer | No. Keep the current behaviour: minute polling only while a session is active or a command is pending. |
| No tray app | Keep failing closed (`tray_unavailable`). Nothing ends without a confirmation the person could see. |
| Retention settings for non-owners | Household admins can view them read-only. Only the owner edits them. |
| Elder self-consent: every helper or only the primary one? | Every helper who can see the elder's data needs the elder's own confirmation. |
| Device-side elder self-consent | Build it (slice 4). |
| COPPA verifiable parental consent | Build it as a signed-form upload with operator review (slice 5). |
| Live-model evals | Add them as a manual `workflow_dispatch` workflow with a spend ceiling. Never run on PRs. |
| Inngest and old agent loop removal | Write the removal PRs now. Merge them only after the shadow comparison matches (manual check). |
| Twilio A2P 10DLC | The owner starts registration on the manual-check day. SMS stays mock-only until it is approved. |
| Privacy page translation | English only (unchanged). |
| Merging | Slices marked **merge on green** merge themselves once CI passes. Every other slice stays an open PR for owner review. |

## 2. Slices

Work them in this order. Each slice gets its own branch from the latest `main` and its own PR. Next free migration number: **0032**.

| # | Slice | Branch | Migration | Merge policy |
| --- | --- | --- | --- | --- |
| 1 | Decisions, docs and mechanical fixes | `claude/closeout/docs-and-fixes` | none | merge on green |
| 2 | Retention settings: admins can view | `claude/closeout/retention-admin-view` | none | open PR |
| 3 | Live-eval workflow | `claude/closeout/live-evals-workflow` | none | open PR |
| 4 | Elder self-consent on the device | `claude/closeout/elder-device-consent` | 0032 | open PR |
| 5 | COPPA signed-form consent | `claude/closeout/coppa-consent` (from slice 4's branch) | 0033 | open PR, depends on 4 |
| 6a | Remove the old agent loop | `claude/closeout/remove-old-agent` | none | open PR, do not merge |
| 6b | Remove Inngest | `claude/closeout/remove-inngest` | none | open PR, do not merge |

### Slice 1: decisions, docs and mechanical fixes
- Copy section 1 into the Open Questions of `_specs/v2-m3-cutover.md` and `_specs/v2-m4-hardening.md`, marking each one decided (2026-11-07).
- `SECURITY.md`: add two residual risks:
  - an attacker controlling the mouse can decline an `end_session` prompt;
  - `end_session` fails closed when no tray app is running.
- Fix the migration snapshot chain. Point `0029_snapshot.json` `prevId` at the snapshot before it, and check the chain 0028 → 0031 is linear. Run `drizzle-kit check`. The snapshot regenerated from the final schema must not produce a new migration.
- Add a test that every eve schedule route and `/api/inngest` (while it exists) refuses a request with no valid Vercel cron token. If the code does not refuse, stop: that is a security fix and needs an open PR, not merge on green.

### Slice 2: retention settings, admins can view
- On the household settings page, household admins see the retention settings read-only. The owner still edits them. The API's GET allows admins; PUT/PATCH stays owner-only, enforced on the server.
- Tests: an admin gets 200 on read and 403 on write, a plain member gets 403 on both, and the owner can still write.

### Slice 3: live-eval workflow
- Add `.github/workflows/evals-live.yml`:
  - `workflow_dispatch` only, `permissions: {}`, a timeout;
  - runs `pnpm --filter @neo/web test:evals:live` with the gateway key from a repository secret (`AI_GATEWAY_API_KEY`; keep the existing name if the code reads a different one);
  - enforces a spend ceiling (`NEO_LIVE_EVALS_MAX_CENTS`, default 200) that the eval run aborts on;
  - every action SHA-pinned with a version comment, SHAs resolved with `gh api`, never guessed.
- Document it in `docs/development.md`. Add any new variable to `.env.example`. CI must not run this workflow.

### Slice 4: elder self-consent on the device
Plan and spec first (`_specs/elder-device-consent.md` from `_specs/template.md`). Put any contract in `docs/contracts.md` before writing code.
- **Who confirms:** the owner, or the helper themselves, starts a confirmation for **each** helper of an Elder-mode member. Each one gets a single-use link and QR code. The token is random, only its hash is stored, it expires after 7 days, and it is tied to one tenant, one elder member and one helper.
- **On the device:** the elder opens the link on their own device. No account is needed, since elders may not have one. The page names the helper and what the helper can see (reuse the "what is shared" content), and offers Confirm or Decline.
- **What is recorded:**
  - Confirm appends `consents` `elder_self_consent` with `method: "device"` and the helper's id.
  - Decline appends a declined record and alerts the owner (templated).
  - The token is burned on first use.
- **Gate:** a helper without the elder's device confirmation is shown as "awaiting the elder's confirmation" in the console. The owner's in-person attestation stays as a fallback, logged and flagged for review (M4 edge case).
- **Abuse limits:**
  - rate-limit the public page;
  - responses for unknown, expired and used tokens are identical;
  - no tenant data appears before a valid token.
- **Data:** migration 0032 (RLS, granted to `app_user` like the other migrations). Add a privacy-page entry (the CI guard enforces it) and a retention rule if the token table is new.
- **Tests:** single use, expiry, the wrong tenant, every helper needed, decline alerts the owner, and the owner fallback is flagged.

### Slice 5: COPPA signed-form consent
Plan and spec first (`_specs/coppa-consent.md`). Branch from slice 4 because of the migration order (0033).
- **Which households:** households outside the operator's own family need verifiable parental consent before any member can be put in Child mode. Mark them with a tenant flag that defaults to **required**. Exempt households are listed in `NEO_COPPA_EXEMPT_TENANT_IDS` (add it to `.env.example`). When the variable is unset, every household is required, so it fails closed.
- **The flow:**
  1. The parent downloads a consent form (a static PDF or a printable page under `apps/web`).
  2. They sign it and upload it (PDF or image, size-capped, type-checked by magic bytes).
  3. The upload is stored encrypted through the existing artifact store (`packages/core` artifact crypto plus `packages/db` blob, with mock mode working).
  4. An operator approves or rejects it in a review queue.
- **Operator:** check whether an operator or super-admin concept exists. If not, use `NEO_OPERATOR_EMAILS` (an allowlist checked on the server against the verified session). An operator view of another tenant's form must be audited and must go through a narrowly scoped SECURITY DEFINER function, like the cross-household functions in 0029.
- **Gate:** enabling Child mode returns a refusal with a templated reason until consent is approved. Revoking consent turns Child mode off and alerts the owner.
- **Data:** migration 0033 and a privacy-page entry. Retention keeps the form for as long as Child mode is on, plus one year, and documents that.
- **Tests:**
  - the gate is enforced in the API, not only the UI;
  - an exempt tenant is not gated;
  - only an operator can approve;
  - a form from one household is never readable by another;
  - a rejected form keeps Child mode off;
  - an unset exempt list gates everyone.

### Slice 6a: remove the old agent loop
- Check first: every capability of `/api/agent*` exists in the eve chat (M3 slice 2 parity list plus `.eml` from #95). List any gap in the PR body, and stop the slice if there is one.
- Delete:
  - `apps/web/app/api/agent` and `/api/agent/confirm`;
  - the old chat UI path and the `NEO_EVE_CHAT` flag, so eve is the only chat;
  - the agent loop pieces of `packages/core` (`agent.ts`, `stream.ts` NDJSON, `context-manager.ts`, `tool-registry.ts`, plus whatever only they use);
  - their `vercel.json` entries.
- Keep everything that eve or the analyzers still import (`wrapToolResult`, `injection-guard`, `routing`, `spend`, `triage`). Update `docs/contracts.md`, `CLAUDE.md` and `.env.example`.
- **Never merge.** The owner flips `NEO_EVE_CHAT=true` in production and checks it first.

### Slice 6b: remove Inngest
- Check first that each Inngest function has a v2 home (`_plans/v2.md` §1.3):
  - `weekly-digest`, `devices-offline`, `breach-monitoring`, `outbox-sweep`, retention/`artifacts-expire`: eve schedules;
  - `signal-escalate`: the policy engine, inline on ingest;
  - `alert-created`: an outbox row;
  - `email-received`: the webhook calls the analyzer directly;
  - `outlook`: check its job and give it an eve schedule if it is periodic.

  Port anything missing first, inside this slice, with tests.
- Then delete:
  - `apps/web/inngest` and `/api/inngest`;
  - `.github/workflows/inngest-sync.yml`;
  - the `inngest` dependency and the `INNGEST_*` variables in `.env.example`;
  - the `NEO_EVE_SCHEDULES` switch (eve becomes the only runner) and the shadow-mode comparison code, unless the docs still need it for the check.
- Update `docs/deployment.md`, `docs/self-hosting.md` and `CLAUDE.md`.
- **Never merge.** The owner compares a shadow cycle (`compareScheduleRuns`) and removes the Vercel integration by hand.

## 3. Loop prompt

Paste this into the driving agent. `<<QWEN STEP>>` is where your own Qwen invocation goes.

```text
You are running the Neo v2 close-out build loop in the neo-personal repo. Source of truth: _plans/v2-closeout.md
(decisions in section 1, slices in section 2). Follow CLAUDE.md rules exactly. Each iteration does ONE slice step,
then ends; the loop repeats until every slice is done.

STATE
- Progress lives in _plans/v2-closeout-state.md (create it on the first iteration; do not commit it). One line per
  slice: `<#> <status> <branch> <PR url or -> <note>`. Status: todo | spec | building | review | pr-open | merged | blocked.
- At the start of every iteration: read the state file, `git fetch origin`, and check CI/merge status of any open
  slice PRs (GitHub MCP tools). Update the state before doing anything else.

PICK WORK (in order)
1. A slice PR with failing CI that you opened: fix it (reproduce the failure locally first, show the same check
   passing, keep the fix to the failure).
2. A "merge on green" slice whose CI is green: squash-merge it, mark merged.
3. The first slice in table order whose status is todo/spec/building/review. Slice 5 needs slice 4 at pr-open;
   slice 6b starts only after 6a is pr-open.
4. Nothing left: go to FINISH.

DO ONE SLICE
a. Branch from latest origin/main (slice 5: from slice 4's branch) with the name in the table.
b. Slices 4 and 5: write the spec from _specs/template.md first, and update docs/contracts.md before code. Commit
   the spec on the branch.
c. Read the code the slice touches. Write exact, file-by-file instructions into the slice's spec section
   ("Slice N: build instructions"): files, functions, signatures, migration SQL, test cases. Small enough that a
   local model can follow them without judgement calls.
d. <<QWEN STEP>> — hand the instructions to the local Qwen model to implement; collect its diff.
e. Review every changed line yourself against the instructions and CLAUDE.md. Hard rules to check every time:
   - every tenant-table query goes through tenantScoped() and carries tenant_id; new tables have RLS and the
     app_user grants like existing migrations;
   - attacker-controlled content reaches the model only through wrapToolResult;
   - eve tools take the tenant from requireTenantCaller, acting tools have always() approval and a server-side
     admin check; critical alerts are templated;
   - new env vars are in .env.example with a comment, and code works when unset; mock mode works;
   - no secrets, synthetic secrets only under test/fixtures/; actions SHA-pinned (resolve via gh api, never guess);
   - public endpoints are rate-limited and leak nothing on bad tokens.
   Fix what is wrong (yourself or by another Qwen pass with corrected instructions). Do not accept code you have
   not read.
f. Run from the repo root with MOCK_MODE=true: pnpm install, pnpm typecheck, pnpm lint, pnpm test, pnpm build,
   plus `pnpm --filter @neo/web exec eve build` when apps/web/agent changed, and drizzle-kit check when a migration
   changed. All must pass. Never skip, disable or weaken a test to get green.
g. Commit with `<emoji> <type>(<scope>): <summary>` (✨ feat · 🐛 fix · 🔒 security · 📝 docs · 🧪 test), push with
   `git push -u origin <branch>`, open a PR (mirror any PR template; body lists what was built, what was not, and
   the manual checks it needs). Mark pr-open.
h. Append the slice's manual checks to the "Manual checks" list in the state file.

STOP AND ASK (mark the slice blocked with the reason, then move to the next slice; never work around these)
- Anything that needs a real secret, a production deploy, a production DB migration, the Vercel or Neon
  dashboards, or a store/signing account.
- A decision not covered by section 1 of the plan that changes security, privacy or what a user sees.
- Slice 1 finds a cron route that does not refuse: that becomes a 🔒 open PR, not merge on green.
- Slice 6a/6b check-first step finds a missing capability you cannot port within the slice.
- Never merge 6a, 6b, or any slice not marked "merge on green". Never push to main directly. Never force-push a
  branch with an open PR unless rebasing your own slice onto a merged dependency.

FINISH (when every slice is pr-open, merged or blocked)
- Write _plans/v2-closeout-manual-checks.md: section 4 of the plan, plus every slice's manual checks from the
  state file, plus a table of PRs (number, title, merge policy, what to verify before merging), plus blocked
  items with their reasons. Commit it on claude/closeout/docs-and-fixes if that is still open, otherwise on a new
  branch claude/closeout/manual-checks with an open PR. Then stop the loop.
```

## 4. Manual checks for the next day (seed list)

The loop appends each slice's own checks to this list.

1. **Production config.** Remove `DEV_AUTH_BYPASS` and `MOCK_MODE` from Vercel Production, and confirm the Blob store exists (`_plans/v2.md` §3).
2. **Shadow comparison.** Run `compareScheduleRuns` over one full cycle for each job. If every job matches, set `NEO_EVE_SCHEDULES`, then merge 6b and remove the Inngest integration and the `INNGEST_*` variables in Vercel.
3. **Eve chat.** Set `NEO_EVE_CHAT=true` in production, use the chat (paste a link, an `.eml`, a playbook, a verdict card), then merge 6a.
4. **Migrations.** Apply 0032 and 0033 to production after slices 4 and 5 merge.
5. **Hardware.** Run the real-hardware list in `_specs/v2-m2-child.md` §7 and the `end_session` checks on Windows and macOS (`docs/beta-checklist.md`).
6. **Policy key.** Confirm `GET /api/devices/policy/keys` on production lists the key pinned in the client builds.
7. **Cron routes.** Probe production's eve schedule routes without the cron token (slice 1 adds the test; this checks the live deployment).
8. **Licences.** Confirm the UT1 and Block List Project licences.
9. **Store releases and signing.** Choose a signing provider and an Apple Developer account, and plan the store submissions.
10. **Twilio.** Start A2P 10DLC registration.
11. **Live evals.** Add the gateway key secret, then run the live-eval workflow once by hand.
12. **COPPA.** Read the consent-form wording yourself (it is a legal document) and set `NEO_COPPA_EXEMPT_TENANT_IDS` to your own household.
13. **Elder self-consent.** Run the device confirmation flow end to end on a real phone.
14. **Housekeeping.**
    - close PR #51;
    - delete the stale `hermes/*` branches;
    - delete leftover Neon branches;
    - archive `pkeenan87/Neo`.
