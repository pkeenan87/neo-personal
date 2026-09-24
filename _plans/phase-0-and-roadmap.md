# Neo Personal — Rebuild Plan

Rebuilding Neo (the Claude-powered SOC agent in `../Neo`, now maintained in the private work GitHub) as a
multi-tenant personal cyber security assistant: web app first, then mobile, then browser extension and
desktop, all deployed on Vercel. The product keeps the **Neo** name on a new domain (`<domain>` below until
one is registered) and is **fully open source under MIT**.

Date: 2026-09-24. Solo developer with Claude Code. Estimates below assume that.

## Decisions made (2026-09-24)

| Decision | Choice | Consequence |
|---|---|---|
| Name | Keep **Neo** | New domain needed before the forward-to-address, OAuth consent screens, and store listings. |
| Tenancy | **Household** | Owner + members, member alerts visible to the owner. Schema carries `tenant_id` from day one. |
| Gmail | **Forward-to-address only** | No Gmail restricted scope, no CASA assessment. Gmail users forward suspicious mail. Outlook.com is the only mailbox connector. |
| Background jobs | **Inngest** | Inbound email, connector sweeps, digests, breach re-checks. |
| Licensing | **Fully open source (MIT)** | Public repo. Secrets hygiene and self-host docs become first-class. Hosted service is the same code. |
| Client order | **Mobile first** | Expo app ships in Phase 2, before the extension and desktop. |
| Lift source | **Private GitHub clone** | Clone the current work repo to scratch, lift from there, not from `../Neo`. |
| Billing | **Free only at launch** | No Stripe until there are users. Per-tenant usage caps protect API spend. Paid tier deferred to Phase 4. |

---

## 1. What carries over from Neo

The local `../Neo` checkout's last commit is 2026-06-09. The private GitHub repo is newer, so the lift
starts by cloning it into a scratch directory and diffing against `../Neo` to see what changed.

Neo is ~28.5K lines of TypeScript in `web/lib` alone. Roughly a third is Azure/Cosmos/vendor coupling and
two thirds is reusable agent infrastructure. Of 78 lib files, 34 have zero Azure or Cosmos references.

### Lift mostly as-is (rename `_neo_trust_boundary` etc. as desired)

| Neo file | Lines | Why it carries over |
|---|---|---|
| `web/lib/agent.ts` | 2200 | Agentic loop, destructive-tool confirmation gate, plan resumption, prompt caching, retry on 429/5xx. Only one Azure reference. |
| `web/lib/context-manager.ts` | 1593 | Truncation + Haiku compression of long conversations. |
| `web/lib/injection-guard.ts` | 456 | Regex scanner and trust-boundary envelope on tool results. Even more important here because the "tool results" are literally attacker-authored emails. |
| `web/lib/stream.ts` | 63 | NDJSON streaming helpers. |
| `web/lib/mcp-client.ts`, `mcp-servers.ts`, `mcp-tool-matcher.ts` | ~600 | MCP support for later integrations. |
| `web/lib/tools.ts` + `executors.ts` registry pattern | — | Keep the schema/executor/mock/registry structure. Delete every vendor executor. |
| `web/lib/skill-parser.ts`, `skill-store.ts` (interface) | — | Skills become the "playbooks" system (e.g. "I clicked the link, what now"). |
| `web/lib/usage-tracker.ts` | 580 | Per-user token budgets. Swap Cosmos for Postgres. Becomes the free/pro tier metering. |
| `web/lib/session-store.ts` interface, `mock-conversation-store.ts` | — | Keep the interface, write one Postgres implementation. Drop v1/v2/dual-mode dispatcher entirely. |
| `web/lib/logger.ts` | — | Keep `SAFE_METADATA_FIELDS` allowlist and `hashPii`. Drop the Event Hub sinks. |
| `web/components/ChatInterface` (1842 lines), `MarkdownRenderer`, `ThinkingBubble`, `CopyButton`, `Toaster` | — | Chat UI is directly reusable. Restyle from "SOC terminal" to consumer-friendly. |
| `web/app/api/agent/*` routes | — | Entry point, confirm route, sessions route. |
| `.github/workflows/ci.yml` conventions | — | SHA-pinned actions, CodeQL, gitleaks, path-filtered checks. |
| `_plans/` + `_specs/` workflow, `CLAUDE.md` structure | — | Keep the plan-then-spec-then-build discipline. |

### Drop

- All Microsoft Sentinel, Defender XDR, Entra ID, Abnormal, ThreatLocker, Lansweeper, AppOmni, Wiz, AI Search executors and helpers (the bulk of `executors.ts`'s 5440 lines).
- Cosmos stores, blob offload, retention classes, legal hold, migration scripts.
- Teams bot, Entra SSO, API-key registry, RBAC roles (replaced by tenant membership roles).
- Azure Functions scheduled-task poller (replaced by Vercel Cron + a durable job queue).
- CLI and the Windows SEA installer. A consumer CLI is not worth building; desktop app replaces it.
- Triage endpoint and triage mappings as-is. The concept returns as "auto-triage of forwarded messages."

### Vendor coupling to redesign, not port

| Neo concept | Neo backing | New backing |
|---|---|---|
| Conversations, sessions | Cosmos DB | Postgres (Neon via Vercel Marketplace), Drizzle ORM |
| Large tool results | Azure Blob | Vercel Blob (raw .eml files, screenshots) |
| Secrets | Key Vault | Vercel env vars + per-tenant envelope encryption keys |
| Auth | Entra ID via Auth.js | Auth.js v5: Google, Apple, email magic link, passkeys (WebAuthn) |
| Multi-instance counters | Cosmos atomic patch | Postgres row locks, or Upstash Redis for rate limits |
| Scheduled tasks | Azure Function poller | Vercel Cron + Inngest for durable background jobs |
| Audit logs | Event Hub | Postgres `audit_events` table + Vercel log drain |

---

## 2. Capability feasibility

Ratings: **Green** = straightforward with public APIs. **Yellow** = doable with caveats. **Red** = no API exists; only indirect approaches.

### 2.1 Email phishing review — Green

Intake paths, in order of ease:

1. **Paste or upload.** Raw text, screenshot (vision), or `.eml`/`.msg` upload. Zero platform dependencies. Ship first.
2. **Forward-to-address.** Each tenant gets `check-<token>@inbound.yourdomain`. Resend or Postmark inbound webhooks deliver parsed MIME to an API route. Works with every mail provider including iCloud. This is the universal path.
3. **Mailbox connectors** (see 2.5 for the sign-in angle):
   - Outlook.com / Hotmail via Microsoft Graph `Mail.Read` on personal accounts. No special verification program. Green.
   - Gmail: **not connecting.** `gmail.readonly` is a Google restricted scope requiring OAuth verification plus an annual CASA security assessment. Decided against. Gmail users use forward-to-address, and the onboarding flow shows them how to set up a Gmail filter that auto-forwards anything they label "Check with Neo."
   - iCloud Mail: no API. IMAP with an app-specific password asks users for a credential most will not understand. Forward-to-address here too, with the same onboarding pattern (iCloud mail rules can forward by label).

Analysis the agent tool performs (deterministic code, then Claude reasons over the structured result):

- Parse `Authentication-Results` for SPF/DKIM/DMARC outcomes; flag Return-Path vs From domain mismatch and display-name spoofing.
- Reply-To divergence, first-time sender, lookalike/homoglyph domain against a brand list and the user's own known contacts.
- Extract every URL (including from HTML, tracking redirectors, QR codes in images) and run the URL pipeline in 2.3.
- Attachment triage: file type vs extension mismatch, hash lookup on VirusTotal, macro presence, HTML/ISO/LNK/one-click lures.
- Content signals: urgency, credential/payment request, gift cards, mismatched branding, invoice fraud patterns.

Output is a structured verdict (see section 4) rendered as a card, not just prose.

### 2.2 Text message (SMS/iMessage) phishing review — Green for paste, Yellow for automatic

- **Paste or screenshot**: Green. Vision on a screenshot handles the most common case (user sends a photo).
- **Mobile share sheet**: Green. Long-press a message, share to the app.
- **iOS automatic filtering**: an `ILMessageFilterExtension` can classify messages from unknown senders and may make a deferred network request to your server. Only unknown senders, and the user must enable it in Settings. Yellow, native Swift work.
- **Android automatic**: needs to be the default SMS app or use notification-listener access. Both are heavy asks with Play Store policy friction. Red for v1.

Signals: shortened URLs, sender number type (short code vs 10-digit vs email-to-SMS), delivery/toll/bank/USPS/IRS lure templates, callback-number scams, "wrong number" pig-butchering openers.

### 2.3 URL review — Green

This is the core shared pipeline that email, SMS, and the extension all call.

| Check | Source | Cost |
|---|---|---|
| Known-bad reputation | Google Safe Browsing (Web Risk API), VirusTotal URL/domain, PhishTank, OpenPhish, URLhaus | VT free tier is 4 req/min; paid tier needed at scale. Others free or cheap. |
| Domain age and registrar | RDAP (free) | Free |
| Certificate | crt.sh, live TLS handshake | Free |
| Redirect chain and final destination | Server-side fetch with SSRF guard (block private ranges, limit hops) | Free |
| Screenshot + DOM | urlscan.io API (hosted, returns screenshot and DOM) or Browserless. Do **not** try to run Playwright inside Vercel functions. | urlscan free tier limited; Browserless ~$0.01/session |
| Lookalike detection | dnstwist-style homoglyph/typosquat generation against top brands + user's own domains | Free |
| Credential-harvest heuristics | Login form on non-brand domain, brand logo on lookalike, favicon hash match | Free |

Claude Fable 5.1 or Opus reasons over the combined evidence. Cache results by normalized URL for 24h so repeat checks across users are free.

### 2.4 Browser extension — Green (Chrome/Firefox), Yellow (Safari)

- Manifest V3, shared codebase via WXT or Plasmo. Chrome and Firefox from one build.
- Features: right-click "Check this link / this page", popup with verdict, optional passive warning when the user is about to submit a password form on a domain they have never visited that looks like a known brand.
- Sends URL + visible text + form metadata to the backend; the backend runs 2.3 plus page-content analysis. Never send page content without the user's per-site or global consent; make the passive mode opt-in.
- Safari requires an Xcode wrapper app and Apple developer account. Do it alongside the iOS app.
- Store review: Chrome Web Store typically days. Firefox AMO similar. Both require a privacy policy and justification for `activeTab`/`scripting` permissions.

### 2.5 Sign-in review for iCloud, Gmail, and other mail services — Red for direct APIs, Yellow via alert parsing

Be honest with users here. Consumer accounts do not expose sign-in logs:

- **Google**: no API for a personal account's own security events. Entra-style sign-in logs exist only for Workspace admins.
- **Microsoft personal (Outlook.com)**: Graph sign-in logs are Entra (org tenant) only.
- **Apple iCloud**: no API of any kind.

What is feasible:

1. **Security-alert email parsing.** Google ("New sign-in from Windows"), Microsoft ("Unusual sign-in activity"), Apple ("Your Apple ID was used to sign in"), plus Meta, Amazon, PayPal, banks. With a connected Outlook mailbox or the forward-to-address, the agent ingests these, extracts device/location/IP/time, geolocates the IP, compares against the tenant's known devices and locations, and flags anomalies. Also detects **fake** security alerts, which are themselves a top phishing lure.
2. **User-pasted screenshots** of the Google "Recent security activity" page or Apple's device list. Vision extracts entries; the agent reviews.
3. **Guided audits.** Walk the user through Google's Security Checkup, Apple's Devices list, and Microsoft's Recent activity page with deep links, asking them to paste what they see.

Position this as "sign-in alert monitoring and account audit," not "sign-in log review."

### 2.6 Additional capabilities worth including

Ranked by value-to-effort for a personal security product:

1. **Breach exposure monitoring.** Have I Been Pwned API (~$4/month key) for email addresses and domains. Alert on new breaches. Also pastes. Green, high perceived value.
2. **"I clicked it / I entered my password" incident playbooks.** Skills-based guided response: change password, revoke sessions, enable 2FA, check forwarding rules, freeze credit. This is where Neo's skills system shines. Green.
3. **Account hardening checklist and score.** Per-account 2FA/passkey status (self-reported or inferred), recovery options, password manager use. Drives the dashboard score. Green.
4. **Scam and social-engineering assessment.** Job offers, romance, crypto, tech-support pop-ups, IRS/Medicare calls, marketplace buyers, deepfake voice call transcripts. Paste any conversation. Green, pure model reasoning.
5. **QR code scanning (quishing).** Mobile camera or image upload, decode, run URL pipeline. Green.
6. **Attachment and file check.** Hash lookup, type mismatch, macro detection, PDF link extraction. No detonation sandbox in v1. Green.
7. **Mailbox rule and forwarding audit.** Attacker-created forwarding rules are the number-one persistence technique after account takeover. Green via the Outlook connector. For Gmail and iCloud, a guided audit with deep links and screenshot ingestion.
8. **Weekly security digest.** Cron job summarises alerts, new breaches, pending checklist items. Email via Resend. Green.
9. **Household tenancy** (decided). A tenant is a household; an owner invites family members; parents see a child's or elderly parent's alerts. Schema carries `tenant_id` from Phase 0; invite flow lands in Phase 2 alongside mobile.
10. **Data-broker and exposure footprint guidance.** Opt-out links and templates. No scraping in v1. Green.
11. **Personal domain monitoring.** If the user owns a domain, watch CT logs and typosquats. Yellow, niche.
12. **Device posture** (mobile/desktop only). OS version, screen lock, jailbreak/root indicators, Wi-Fi security. Yellow, native code.
13. **Dark-web / stealer-log monitoring.** Beyond HIBP this needs paid feeds. Defer.

---

## 3. Target architecture

### Repo layout (Turborepo + pnpm)

```
neo-new/
├── apps/
│   ├── web/            Next.js 16 App Router: marketing, auth, chat, dashboard, API routes
│   ├── extension/      WXT (MV3) — Chrome, Firefox, later Safari
│   ├── mobile/         Expo (React Native) — iOS + Android, share extension
│   └── desktop/        Tauri v2 wrapping the web app — tray, global hotkey, clipboard check
├── packages/
│   ├── core/           Agent loop, context manager, injection guard, tool registry (lifted from Neo)
│   ├── tools/          URL, email, SMS, breach, sign-in-alert analyzers + external API clients
│   ├── db/             Drizzle schema, migrations, tenant-scoped query helpers
│   ├── verdict/        Shared verdict schema (zod) + card components
│   ├── api-client/     Typed client used by extension, mobile, desktop
│   └── ui/             Shared components (chat, verdict card, markdown)
├── _plans/  _specs/    Same workflow as Neo
└── CLAUDE.md
```

### Vercel deployment model

- Next.js on Vercel with Fluid compute. Streaming agent turns fit inside function limits (Hobby 300s, Pro 800s max duration). Long tool chains still stream progress, so users never stare at a spinner.
- No long-lived processes. Anything that outlives a request (inbound email processing, connector polling, weekly digest, HIBP re-checks) goes through **Inngest** triggered by webhooks and **Vercel Cron**.
- No headless browser on Vercel. Use urlscan.io or Browserless for screenshots.
- Postgres via Neon. Vercel Blob for raw artifacts. Upstash Redis for rate limiting and URL-verdict cache.
- Preview deployments per PR, with a seeded Neon branch database.

### Multi-tenancy and security posture

- Tenant = household. Tables carry `tenant_id`; every query goes through a helper that injects it. Enable Postgres RLS as defense in depth.
- Auth.js v5 with Google, Apple, magic link, and passkeys. A security product that lacks passkeys will get called out.
- Raw emails and screenshots encrypted at rest with a per-tenant data key (envelope encryption; wrap keys with a master key in Vercel env, plan a KMS move later). Default retention 30 days for raw artifacts, verdicts kept longer. One-click "delete everything."
- Connector OAuth tokens encrypted the same way. Request minimum scopes. Never store passwords.
- Injection guard is the primary control: every email, SMS, and web page is attacker-controlled input and goes into the model wrapped in the trust-boundary envelope with an explicit instruction that it is evidence, not instructions.
- Confirmation gate from Neo applies to any action tool added later (e.g. "delete this forwarding rule," "report as phishing to Microsoft").
- Rate limits per tenant and per IP. Budget metering via the lifted usage tracker enforces a per-tenant monthly check cap and a daily token cap. These caps are the only spend control at launch; there is no paid tier until Phase 4.
- Signup is open but the cap defaults are conservative and adjustable by env var without a deploy (same pattern as Neo's `USAGE_LIMIT_*` settings).

### Open source posture

- MIT license, public repo from the first commit. Nothing in the repo may depend on a secret being present: mock mode for every external API, seeded fixtures, `.env.example` complete.
- gitleaks in CI is blocking, not advisory. Add a pre-commit hook too.
- `docs/self-hosting.md` from Phase 1: Vercel + Neon + Inngest + Resend free tiers should let anyone run their own instance. The hosted service at `<domain>` runs the identical code.
- Threat model and `SECURITY.md` with a disclosure policy, since the product invites scrutiny.
- Public roadmap via GitHub Projects; the `_plans/` and `_specs/` directories are public too.

### Model choices

| Use | Model | Notes |
|---|---|---|
| Chat agent | `claude-opus-5` | Adaptive thinking (default on), `output_config.effort: "medium"` for chat, raise to `high` for incident playbooks. Prompt caching on system + tools. Enable server-side `fallbacks: "default"` for refusal handling. |
| Bulk auto-triage of forwarded/connector messages | `claude-sonnet-5` | Structured output (`output_config.format`) into the verdict schema. Effort `low`. Batch API for nightly connector sweeps at 50% cost. |
| Context compression, titles | `claude-haiku-4-5` | Same role Haiku plays in Neo today. |

Cost sanity: a typical email check with tool calls is roughly 15–25K input tokens (mostly cached) and 1–2K output. On Opus 5 that is a few cents per check; on Sonnet 5 under two cents. A free tier of 20 checks/month is affordable.

---

## 4. Verdict schema (the product's spine)

Every analyzer returns this, and dashboards, cards, extension badges, and mobile notifications all render it:

```ts
{
  subject_type: "email" | "sms" | "url" | "page" | "signin_alert" | "file" | "conversation",
  verdict: "malicious" | "suspicious" | "likely_safe" | "insufficient_evidence",
  confidence: 0..1,
  headline: string,                 // one sentence for the user
  indicators: [{ severity, category, evidence, explanation }],
  recommended_actions: [{ action, urgency, deep_link? }],
  iocs: { urls[], domains[], ips[], hashes[], phone_numbers[] },
  raw_ref: blob_id                  // encrypted artifact
}
```

Use structured outputs (`output_config.format`) so the schema is enforced by the API, not by parsing.

---

## 5. Phased roadmap

Weeks are calendar weeks for one developer using Claude Code heavily. Each phase ends deployed to Vercel.

### Phase 0 — Foundation (weeks 1–2)

- Clone the private Neo repo to scratch; diff against `../Neo`; lift `packages/core` with every Azure import removed (checklist in the spec).
- Turborepo scaffold, MIT license, `SECURITY.md`, public repo, CI (typecheck, lint, vitest, CodeQL, blocking gitleaks, SHA-pinned actions).
- Postgres schema (tenants, users, memberships, conversations, turns, verdicts, artifacts, audit_events, usage), Drizzle migrations, tenant-scoped query helper, RLS.
- Auth.js (Google + magic link first; Apple and passkeys in Phase 2), household tenant created on signup.
- Chat UI lifted from Neo, restyled. One tool: URL analysis (Safe Browsing + VT + RDAP + redirect chain + urlscan).
- Usage caps wired from day one. Deploy to Vercel with preview deployments.
- **Exit:** a stranger can sign up and ask "is this link safe?" and cannot run up the API bill.

### Phase 1 — Email and SMS analysis (weeks 3–5)

- Email parser (`mailparser`), header auth analysis, URL/attachment extraction, verdict schema + card component.
- Paste, `.eml` upload, screenshot (vision) intake for both email and SMS.
- Forward-to-address via Resend inbound webhook → Inngest job → Sonnet 5 triage → verdict stored → user notified by email. Onboarding guides for Gmail, iCloud, Outlook, and Yahoo forwarding rules.
- History and dashboard v1: verdict list, counts, top indicators.
- Incident playbooks as skills: clicked link, entered password, sent gift cards, shared a code.
- `docs/self-hosting.md`.
- **Exit:** the core value proposition works on every mail provider without OAuth.

### Phase 2 — Mobile, connectors, sign-in alerts (weeks 6–10)

- Expo app: auth, chat, share-sheet intake for messages/links/screenshots, QR scanner, push notifications for verdicts. TestFlight and Play internal track. Apple Sign In and passkeys added to Auth.js here because App Store review expects Apple Sign In when Google is offered.
- Household invites and roles; owner sees member verdicts and alerts.
- Outlook.com connector (Graph `Mail.Read`, `MailboxSettings.Read` for the forwarding-rule audit).
- Sign-in-alert parser for Google/Microsoft/Apple/Meta/Amazon/PayPal alert templates (from forwarded mail or the Outlook connector), IP geolocation, known-device memory, fake-alert detection.
- HIBP breach monitoring with weekly Inngest re-check.
- **Exit:** phone-first protection exists; "review my sign-ins" has a truthful answer.

### Phase 3 — Extension and desktop (weeks 11–14)

- WXT extension: context-menu link/page check, popup, badge, opt-in passive password-form warning. Chrome + Firefox store submissions.
- Tauri desktop: wraps the web app, adds tray icon, global hotkey "check clipboard," native notifications. Windows and macOS builds signed via CI.
- Weekly digest email.
- Account hardening checklist and score on the dashboard.
- **Exit:** four client surfaces live, all free.

### Phase 4 — Deepening and sustainability (weeks 15+)

- Paid tier if usage justifies it: Stripe, tier gating on connectors and household size, metering already in place.
- Safari extension via Xcode wrapper. iOS `ILMessageFilterExtension` for automatic SMS filtering of unknown senders.
- Guided Google/Apple/Microsoft account audits with screenshot ingestion.
- Action tools with confirmation gate: remove malicious Outlook forwarding rule, report phish to provider, block sender.
- Device posture checks in mobile/desktop. Personal domain monitoring.
- Evals: labeled phishing/benign corpus, hill-climb verdict accuracy before each model or prompt change. Publish the eval harness in the repo.

---

## 6. Feasibility summary

| Requested capability | Rating | Phase | Note |
|---|---|---|---|
| Email phishing review | Green | 1 | Paste/upload/forward first; Outlook connector P2; no Gmail connector by decision |
| SMS phishing review | Green | 1 | Paste/screenshot P1; share sheet P2; iOS filter extension P4; Android auto-filter not planned |
| URL phishing review | Green | 0 | Shared pipeline everything else uses |
| Browser extension | Green | 3 | Chrome/Firefox P3, Safari P4 |
| Sign-in review (iCloud/Gmail/others) | Red as asked, Yellow reframed | 2 | No consumer sign-in APIs exist; deliver via alert-email parsing and guided audits |
| Vercel multi-tenant service with signup | Green | 0 | Household tenancy, Auth.js, Neon, Inngest |
| Agentic chatbot | Green | 0 | Lifted from Neo |
| Dashboards | Green | 1 | Driven by the verdict schema |
| Web app | Green | 0 | |
| Mobile app | Green | 2 | Expo; native extensions P4 |
| Desktop app | Green | 3 | Tauri wrapper |

---

## 7. Remaining open items

1. **Domain.** Register one before Phase 1's forward-to-address goes live. It also gates the Apple and Google OAuth consent screens in Phase 2.
2. **Resend vs Postmark** for inbound email. Resend is assumed; confirm inbound webhook pricing at expected volume.
3. **urlscan.io vs Browserless** for screenshots. Start on urlscan's free tier; switch if rate limits bite.
4. **Usage cap defaults.** Pick launch numbers for checks/month and tokens/day per tenant once Phase 0 shows real per-check token costs.

## 8. Immediate next steps

1. Clone the private Neo repo into the scratch directory and diff against `../Neo` to see what changed since June.
2. `git init` here with the MIT license and `SECURITY.md`, scaffold the Turborepo, and lift `packages/core` with a checklist of every Azure import removed.
3. Write `_specs/url-analysis.md`, `_specs/tenant-auth.md`, and `_specs/usage-caps.md` using Neo's spec template, then build Phase 0.
