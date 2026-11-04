# Security policy

Neo is a security product that reads attacker-authored content for a living. We expect it to be probed, and we welcome reports.

## Supported versions

Neo is pre-alpha and ships continuously from `main`. There are no versioned releases yet.

| Version | Supported |
|---|---|
| `main` (and the hosted service, which runs `main`) | Yes |
| Any older commit or fork | No. Update to `main` first. |

Once tagged releases start, the latest minor release will be supported and this table will change.

## Reporting a vulnerability

**Do not open a public issue, discussion, or pull request for a vulnerability.**

Report privately through GitHub Security Advisories: open the repository's **Security** tab and choose **Report a vulnerability** (or go to `/security/advisories/new` on the repository).

Please include:

- What the issue is and what an attacker gains (for example: read another household's verdicts, exceed usage caps, reach an internal address from the URL analyzer).
- Steps to reproduce, ideally against a local instance with `MOCK_MODE=true`.
- The commit SHA or date you tested against, and whether it was self-hosted or the hosted service.
- Any proof-of-concept payloads (prompt injection strings, URLs, emails). Redact any real third-party personal data.

If you cannot use GitHub Security Advisories, email **privacy@neoshield.dev** and ask for a private channel. Do not send vulnerability details in the first message.

## Response targets

These are targets for a solo-maintained project, not contractual SLAs.

| Step | Target |
|---|---|
| Acknowledge the report | 3 business days |
| Initial assessment and severity | 7 business days |
| Fix for Critical / High | 30 days |
| Fix for Medium / Low | 90 days |
| Public advisory | After the fix ships, coordinated with the reporter |

We follow 90-day coordinated disclosure by default. If a fix needs longer, we will tell you why and agree a date. We credit reporters in the advisory unless you ask us not to.

## Safe harbor

We will not pursue or support legal action against anyone who, in good faith:

- Tests only against their **own** self-hosted instance or their **own** account and household on the hosted service.
- Avoids privacy violations, data destruction, and service degradation. Stop and report as soon as you can access data that is not yours; do not keep, share, or use it.
- Does not run automated scanners, load tests, or denial-of-service against the hosted service.
- Does not attempt to exhaust other users' usage caps or run up API spend on the hosted service beyond what a proof of concept needs.
- Does not use social engineering, phishing of real people, or physical attacks.
- Gives us reasonable time to fix before public disclosure.

If you comply with this policy, we consider your research authorized, and we will say so if anyone asks. If you are unsure whether something is in scope, ask first through a private advisory.

## Scope

In scope:

- Everything in this repository: `apps/`, `packages/`, CI and supply-chain configuration in `.github/`, and deployment config (`vercel.json`).
- The hosted Neo service, within the safe-harbor limits above.

Out of scope:

- Vulnerabilities in third-party services Neo calls (Anthropic, Vercel AI Gateway and the model providers behind it, Google Safe Browsing, VirusTotal, urlscan.io, Neon, Vercel, Resend, Inngest). Report those to the vendor.
- A self-hoster's own misconfiguration (for example, running the app as a Postgres superuser, which bypasses RLS; see `docs/self-hosting.md`).
- Verdict accuracy on its own (a phishing page Neo rated `likely_safe`). Please open a normal issue with a redacted sample. It becomes a security issue when an attacker can **reliably force** a wrong verdict through prompt injection or analyzer manipulation; report that privately.
- Missing best-practice headers or findings with no demonstrated impact.

## Threat model

Neo's job is to take untrusted content and give an ordinary person a safety verdict about it. The main assets are household data (submitted emails, SMS, URLs, verdicts, conversation history), OAuth tokens for connected mailboxes, API credentials, and the operator's API budget. The main controls follow.

### Desktop clients

The Omarchy bar plugin (and future desktop apps) authenticate with a personal access token (`neo_dt_…`) that is stored only as a SHA-256 hash and resolves to the same `{ userId, tenantId, role }` as a browser session. Tokens are obtained through a device-authorization flow: the client's secret device code is hashed at rest, the token is minted only when an approved request is redeemed and is delivered once, requests expire after ten minutes, and the approval page names the account and warns against approving a sign-in you did not start. A desktop token cannot create or approve other tokens. Tokens are listed and revoked under Settings → Desktop. See `_specs/desktop-auth.md`.

### Attacker-controlled input into an LLM

Every email, SMS, screenshot, web page, redirect target, and third-party API response Neo analyzes may be written by the attacker Neo is judging. The attacker's goal is a false `likely_safe` verdict, or getting the agent to act for them.

- All such content enters the model only through `wrapToolResult` (`@neo/core`), a trust-boundary envelope that marks it as evidence, not instructions.
- User messages are scanned by `scanUserInput` before the agent runs. `INJECTION_GUARD_MODE=monitor` logs detections; `block` refuses them.
- Deterministic analyzers (Safe Browsing, VirusTotal, RDAP, redirect chain, lookalike checks) produce structured signals that page text cannot override. A verdict of `likely_safe` should never rest on the content's claims about itself.
- The verdict is produced through a structured-output schema (`@neo/verdict`), so the model cannot return free-form content where a verdict is expected.

### Where prompts go

Prompts contain household data: chat messages, and analyzer output about submitted emails, messages and pages (itself wrapped as untrusted evidence).

- **Direct mode** (`NEO_MODEL_GATEWAY` unset): every model call goes to the Anthropic API.
- **Gateway mode** (`NEO_MODEL_GATEWAY=true`): every model call goes to Vercel AI Gateway, which forwards it to one provider. Each request sets `zeroDataRetention: true` and `inferenceRegion: { scope: "zone", geoRegion: "us" }`; the gateway fails the request closed rather than use a provider that retains data or serves outside the US. The provider order is fixed per model family: Anthropic models on `anthropic`, `bedrock`, `vertexAnthropic`, `claudeaws`; OpenAI on `openai`; Kimi on `baseten`, `fireworks`, `bedrock`; Grok (experimental) on `xai`, `vertex`, where the US pin is relaxed because the gateway reports no region for Grok (ZDR stays on). Large-tier models carry a gateway model fallback to the family's medium model (`providerOptions.gateway.models`); the fallback runs under the same ZDR and region policy, and the served model is recorded from the gateway's routing metadata. `NEO_GATEWAY_REGION=global` drops the US pin for an instance; non-Anthropic families are off unless listed in `NEO_MODEL_FAMILIES`.
- Only the **chat turn** follows a member's chosen family. Context compression (Haiku 4.5), forwarded-email and SMS triage (Sonnet 5) and incident playbooks (Opus 5) always use Anthropic models.
- `metadata.user_id` is a hash of the user id (`hashPii`), never an email address.

### What the router sees

With `NEO_ROUTER=jev`, each chat turn is classified by TypeSafe AI's Jev model through the gateway before the agent runs. Jev receives only a redacted excerpt of the latest user message (URLs reduced to their registrable domain, email addresses and phone numbers masked, capped at about 4,000 characters) plus structural signals (whether there is an attachment and its kind, how many turns the conversation has, the previous verdict label). It never receives tool results, attachments, or the rest of the conversation, and its answers only choose a model tier; they never reach the agent's context. The Jev call requests ZDR and fails closed; Jev has no ZDR endpoint today, so with default settings the deterministic rules route every turn and nothing is sent to Jev. The message text is never logged by the router. A crafted message can at most move its own turn to a bigger or smaller model, which the usage caps and gateway budget already bound.

### Prompt injection toward actions

Phase 0 has one read-only tool (`check_url`). Any future tool that changes external state (delete a mail rule, report a sender) is marked `destructive` and pauses the agent loop for explicit user confirmation, which injected content cannot supply.

### SSRF through URL analysis

The URL analyzer fetches attacker-chosen URLs from our servers to follow redirect chains.

- Resolve the hostname and block private, loopback, link-local, CGNAT, multicast, and cloud metadata ranges (`10/8`, `172.16/12`, `192.168/16`, `127/8`, `169.254/16`, `100.64/10`, `::1`, `fc00::/7`, `fe80::/10`, and IPv4-mapped IPv6 forms) **on every hop**, and connect to the resolved address so DNS rebinding cannot swap it.
- `http`/`https` only; standard ports only; a small hop limit; short timeouts; a response-size cap; no cookies or credentials; `redirect: "manual"` so each hop is validated.
- Screenshots and full rendering go to urlscan.io, not a headless browser in our functions.

### Tenant isolation

A tenant is a household. A user must never read or change another household's data.

- Every tenant table carries `tenant_id`. All queries go through `tenantScoped()` (`@neo/db`), which injects it.
- Postgres row-level security keyed on `app.tenant_id` is defense in depth. It only works if the app connects as a **non-superuser, non-owner** role without `BYPASSRLS`.
- The tenant id comes from the server-side session (`{ userId, tenantId, role }`), never from request bodies or query strings.
- `DEV_AUTH_BYPASS` is refused when `NODE_ENV=production` or `VERCEL_ENV` is `production` or `preview` (previews are public URLs).

### Secrets

- No secrets in the repository. gitleaks runs in CI as a blocking check over full history and as a pre-commit hook.
- Every external API has a mock mode, so development and CI never need real keys.
- Production secrets live in Vercel environment variables, scoped per environment. Preview deployments get separate, lower-privilege keys.
- Logs use an allowlist of metadata fields and hash PII (`hashPii`); submitted content and tokens are never logged.

### OAuth tokens and raw artifacts at rest

From Phase 1 (raw artifacts) and Phase 2 (mailbox connectors):

- Connector OAuth tokens and raw artifacts (emails, screenshots) are encrypted with a per-tenant data key (envelope encryption), wrapped by a master key held outside the database.
- Connectors request minimum scopes (for example Outlook `Mail.Read`, never write scopes without a confirmed action). Neo never stores passwords.
- Raw artifacts default to 30-day retention, and a user can delete everything in one action.

### Abuse and spend

Signup is open and each check costs real money. Per-tenant monthly check caps and daily token caps (`USAGE_CAP_MONTHLY_CHECKS`, `USAGE_CAP_DAILY_TOKENS`) are enforced before the agent runs and return HTTP 429 when exceeded. See `_specs/usage-caps.md`. In gateway mode the AI Gateway API key carries a monthly budget; once it is spent the gateway returns HTTP 402 and Neo shows a budget-exhausted message instead of running up cost.

### v2 trust boundaries (protection modes, eve agent, devices)

v2 adds household members without accounts, signed policies that devices enforce, an agent (eve) with tools, and email and SMS entry points (`_specs/v2-architecture.md`, `_specs/v2-m4-hardening.md`). Each list below names only controls that exist in the code, with the file that implements them; what is missing is a residual risk, never a claimed control.

**eve tools and sessions.**

- The tenant comes from the verified caller only (`requireTenantCaller`, `apps/web/agent/lib/tenant.ts`), never from tool input or model output. Database access goes through `tenantScoped()`, and every tool result reaches the model through `wrapToolResult` (`apps/web/agent/lib/tool-io.ts`).
- eve has no per-session access list, so each session records its creator in `eve_sessions` and the route auth lets back in only the same household and user for continue, stream and control requests (`apps/web/agent/lib/app-session.ts`, `apps/web/lib/server/eve-session-owner.ts`). An unknown session id is denied after a short wait; any error denies. `NEO_EVE_CHAT` must be `true` or nobody is a caller.
- Acting tools use `always()` approval, and the server re-reads the caller's role from the database (`requireHouseholdAdmin`, `apps/web/lib/server/incident-actions.ts`). The offline evals (`apps/web/agent/evals/`) check this with a scripted, adversarial model.
- Residual: eve's session storage (Vercel Workflow) is outside our database; we do not encrypt it per household and do not set its retention. The offline evals cover the deterministic layer only; whether a model resists an injection is checked only by the optional live evals (`apps/web/evals/`, `NEO_LIVE_EVALS=1`).

**Policy bundles.**

- Bundles are signed ES256 (`apps/web/lib/server/policy-signer.ts`). With `NEO_POLICY_KMS_ISSUER` the key lives in Vercel KMS and never leaves it. The env-key backend (`NEO_POLICY_SIGNING_KEY`) also exists; only an ephemeral dev key is refused on production and preview, where no signer means a 503 and no bundle. Clients pin public keys at build time and never trust the keys endpoint.
- The extension (`apps/extension/lib/policy/sync.ts`) rejects a bundle for another `deviceId` and an older `issuedAt` (rollback), reporting `tamper_detected`. The desktop agent (`apps/desktop/crates/agent-core/src/policy.rs`, `agent-service/src/agent/child.rs`) verifies the signature against pinned keys, re-verifies the stored bundle at start, and rejects another device's bundle.
- Residual: the desktop agent has no `issuedAt` rollback check. A compromised server can sign anything: **signing proves origin, not intent**, so a bundle that is validly signed but wrong (a bug, a bad rule, a malicious operator) is applied by every device it names. Rotation needs clients that carry both keys to ship first (`docs/deployment.md`, rotation runbook).

**Email decision links (child requests).**

- The link carries a random 32-byte token stored only as a SHA-256 hash, compared in constant time, expiring after 24 hours and cleared when the request is decided (`apps/web/lib/server/child-requests.ts`). It only identifies the request: opening the page decides nothing, and a signed-in owner of the same household must confirm.
- Residual: a forwarded email lets any other signed-in owner of the same household decide.

**Household memory (prompt-injection persistence).** Memory is a persistence channel for injected text by design, so it is constrained rather than trusted.

- Writes are owner-only; the `remember` tool needs `always()` approval that shows the exact text, with hidden characters spelled out (`apps/web/agent/tools/remember.ts`). Content rules refuse contact details, links, credentials and payment data on every write (`apps/web/lib/server/memory-rules.ts`). Entries are 280 characters at most and expire after 365 days (`packages/db/src/household-memory.ts`); owners can list and forget them.
- Nothing is put in the system prompt. The model sees memory only by calling `recall`, whose result goes through `wrapToolResult`.
- Residual: the content rules are a blocklist, and an owner can approve text that was injected into the conversation. The approval prompt is the control, and it relies on the owner reading it.

**Twilio SMS (off, mock-only).** `NEO_TWILIO_ENABLED` must be exactly `true`; otherwise every route answers 404 (`apps/web/agent/channels/twilio.ts`). eve checks `X-Twilio-Signature` on every request; unknown numbers get one fixed reply, rate limited per number, and never reach the model. A number maps to a member only through a verified `member_channels` row. Every outbound call goes to a mock, so nothing reaches the network. Residual: no IP allowlisting; no STOP/HELP handling, opt-in records or quiet hours; real signature verification behind the Next rewrite still needs `webhookUrl` configured. Re-review before enabling.

**Category lists.** Upstream commits are pinned and their files sha256-checked on every fetch (`scripts/category-lists/sources.json`, `fetch.mjs`). The extension checks each downloaded file against the lists manifest's sha256 and length before storing it (`apps/extension/lib/policy/categories.ts`). Residual: the manifest is served from our origin and is not signed, so it has the same trust as the server; upstream lists contain mistakes, which show up as false blocks that the allow list and the child's unblock request correct. The licence status of the upstream lists is not fully verified (`_specs/v2-m2-child.md`).

**eve schedules (shadow mode).** A shadow run has no effects object by type, so it cannot reach a mailer, an alert insert or a delete, and `schedule_runs` records counts and a SHA-256 digest of the planned actions, never an address or message content (`apps/web/lib/server/schedules/core.ts`). Residual: the schedule routes are generated by eve and Vercel Cron; nothing in this repository checks the caller (the spec's "cron token only, 404 otherwise" claim is unverified here), and a manual probe of the deployment is still owed.

**Device commands (`end_session`).**

- The `end_session` tool needs `always()` approval and an owner re-checked in the database. The device, tool and remote ID come from the incident's stored signals, never from the model, and the tool only requests: it never reports the session ended (`apps/web/agent/tools/end_session.ts`, `apps/web/lib/server/end-session.ts`). The device must have been in contact within 2 minutes, and requests are rate limited per device and hour.
- The command rides inside the device's signed policy bundle, so it is bound to that device by the bundle's `deviceId`. It expires after 10 minutes (`DEVICE_COMMAND_TTL_MS`, `packages/db/src/device-commands.ts`), the agent remembers handled command ids so a replayed bundle is a no-op, and the person at the computer confirms on screen unless it is a child's computer (`apps/desktop/crates/agent-core/src/commands.rs`).
- Residual: not yet exercised on real hardware. Because the desktop agent has no `issuedAt` rollback check, a replayed older bundle is limited only by the command's own expiry and the handled-id memory.

**Consent.** Enabling Child or Elder mode is refused without the current notice version (`consent_required`), and Elder also needs the owner's in-person attestation (`attestation_required`); both are recorded in `consents` (`apps/web/lib/server/member-console.ts`, wording in `apps/web/lib/consent-text.ts`). Residual: the attestation is the owner's word; the elder's own confirmation on their device is not built; verifiable parental consent (COPPA) is not built (below).

**Retention.** Owners set how long signals, alerts, child requests and household memory are kept (`tenants.retention_*_days`, bounds in `packages/core/src/retention.ts`, purges in migration 0030). Fixed periods (migration 0031, `purge_old_household_records`): finished notification-outbox rows after 30 days (any after 90), spent invitations after 30, device commands 30 days after expiry, `eve_sessions` after 90 (the chat then fails the owner check closed), usage events after 400. Residual: consents, the audit trail and incident actions are kept until the household is deleted, by decision (`_specs/v2-followups.md` Open Questions). eve's own session storage is outside our control.

### Owner actions

Things only the operator can do or decide:

- **Key rotation.** Follow the runbook in `docs/deployment.md` (add the new key, ship clients carrying both keys, then activate). Until clients ship with the new key, treat a leaked signing key as full compromise of Child and Elder enforcement.
- **Flags.** `NEO_EVE_CHAT` (eve chat; unset means closed), `NEO_EVE_SCHEDULES` (which jobs run live in eve instead of Inngest; default none, shadow only) and `NEO_TWILIO_ENABLED` (SMS; mock-only, keep off) are all off unless set. Do not turn on `NEO_TWILIO_ENABLED` for real sends before A2P registration and a security review.
- **COPPA gate.** Verifiable parental consent for minors is deferred. It is acceptable for the maintainer's own household. It must be built before any outside household's children are protected, and the privacy page (`apps/web/app/privacy/page.tsx`) changes with it.
- **Beta.** The pre-beta gates are in `docs/beta-checklist.md`.

### Supply chain

- GitHub Actions are pinned to full commit SHAs with a version comment. Workflow token permissions are minimal per job.
- `pnpm install --frozen-lockfile` in CI; Dependabot proposes updates weekly.
- CodeQL `security-extended` runs on every push and pull request.
