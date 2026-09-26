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

If you cannot use GitHub Security Advisories, contact the maintainer via the email on their GitHub profile and ask for a private channel. Do not send vulnerability details in the first message.

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

### Attacker-controlled input into an LLM

Every email, SMS, screenshot, web page, redirect target, and third-party API response Neo analyzes may be written by the attacker Neo is judging. The attacker's goal is a false `likely_safe` verdict, or getting the agent to act for them.

- All such content enters the model only through `wrapToolResult` (`@neo/core`), a trust-boundary envelope that marks it as evidence, not instructions.
- User messages are scanned by `scanUserInput` before the agent runs. `INJECTION_GUARD_MODE=monitor` logs detections; `block` refuses them.
- Deterministic analyzers (Safe Browsing, VirusTotal, RDAP, redirect chain, lookalike checks) produce structured signals that page text cannot override. A verdict of `likely_safe` should never rest on the content's claims about itself.
- The verdict is produced through a structured-output schema (`@neo/verdict`), so the model cannot return free-form content where a verdict is expected.

### Where prompts go

Prompts contain household data: chat messages, and analyzer output about submitted emails, messages and pages (itself wrapped as untrusted evidence).

- **Direct mode** (`NEO_MODEL_GATEWAY` unset): every model call goes to the Anthropic API.
- **Gateway mode** (`NEO_MODEL_GATEWAY=true`): every model call goes to Vercel AI Gateway, which forwards it to one provider. Each request sets `zeroDataRetention: true` and `inferenceRegion: { scope: "zone", geoRegion: "us" }`; the gateway fails the request closed rather than use a provider that retains data or serves outside the US. The provider order is fixed per model family: Anthropic models on `anthropic`, `bedrock`, `vertexAnthropic`, `claudeaws`; OpenAI on `openai`; Kimi on `baseten`, `fireworks`, `bedrock`; Grok (experimental) on `xai`, `vertex`, where the US pin is relaxed because the gateway reports no region for Grok (ZDR stays on). `NEO_GATEWAY_REGION=global` drops the US pin for an instance; non-Anthropic families are off unless listed in `NEO_MODEL_FAMILIES`.
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

### Supply chain

- GitHub Actions are pinned to full commit SHAs with a version comment. Workflow token permissions are minimal per job.
- `pnpm install --frozen-lockfile` in CI; Dependabot proposes updates weekly.
- CodeQL `security-extended` runs on every push and pull request.
