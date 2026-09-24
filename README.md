# Neo

**A personal cyber security agent, powered by Claude.** Ask Neo whether a link, email, or text message is a scam, and get a clear verdict with the evidence behind it and what to do next.

[![CI](https://github.com/pkeenan87/neo-personal/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/pkeenan87/neo-personal/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Status: pre-alpha](https://img.shields.io/badge/status-pre--alpha-orange.svg)

> **Project status: pre-alpha, Phase 0.** The foundation is being built: monorepo, CI, database, sign-in, chat, and URL analysis. Nothing here is ready to protect anyone yet. Interfaces, schema, and docs will change without notice.

## What Neo does

Neo is built for households, not security teams. The roadmap:

- **Phishing review** for links, emails, and text messages. Paste it, upload it, screenshot it, or forward it. Neo checks reputation services, domain age, redirect chains, sender authentication, and lookalike domains, then Claude reasons over the evidence and returns a structured verdict (`malicious`, `suspicious`, `likely_safe`, or `insufficient_evidence`).
- **Sign-in alert monitoring.** Consumer accounts (Google, Apple, Microsoft personal) have no sign-in log API, so Neo reads the security alert emails those services send, checks them against your known devices and locations, and spots fake "new sign-in" alerts, which are a common lure themselves.
- **Breach monitoring** via Have I Been Pwned, with alerts when your addresses show up in a new breach.
- **Incident playbooks** for "I clicked the link", "I entered my password", or "I paid with gift cards": step-by-step guided response.
- **Household accounts.** One owner, family members, shared alerts.

Clients, in order: **web** (now), **mobile** (iOS and Android, with share-sheet intake), **browser extension** (Chrome and Firefox), **desktop** (Windows and macOS). The full plan is in [`_plans/phase-0-and-roadmap.md`](_plans/phase-0-and-roadmap.md).

## Quick start

No API keys needed. Mock mode returns deterministic fixtures for every external service.

Requires Node 22+ and pnpm (`corepack enable`).

```bash
git clone https://github.com/pkeenan87/neo-personal.git neo && cd neo
pnpm install
cp .env.example apps/web/.env.local
MOCK_MODE=true DEV_AUTH_BYPASS=true pnpm --filter @neo/web dev
```

Open <http://localhost:3000> and ask "is https://paypa1-secure-login.com/verify safe?". In mock mode the real agent loop runs against a scripted model, so no Anthropic key or database is needed; set `ANTHROPIC_API_KEY` and `MOCK_MODE=false` for real answers. `DEV_AUTH_BYPASS` signs you in as a local dev user and is ignored on production and preview deployments.

More in [docs/development.md](docs/development.md): local Postgres, running with real API keys, the pre-commit secret scan, and every command.

## Repository layout

```
.
├── apps/
│   └── web/            Next.js 16 app: UI, auth, API routes (/api/agent streams NDJSON)
├── packages/
│   ├── core/           Agent loop, context management, injection guard, tool registry
│   ├── tools/          URL analysis and external API clients (each with a mock mode)
│   ├── db/             Drizzle schema, migrations, tenant-scoped queries, usage caps, RLS
│   └── verdict/        Shared verdict schema (zod) and JSON schema for structured outputs
├── docs/               contracts.md (package interfaces), development, self-hosting, deployment
├── _plans/             Roadmap and plans
├── _specs/             Feature specs, written before the code
└── .github/            CI (typecheck, lint, test, build, CodeQL, gitleaks), Dependabot, templates
```

Mobile, extension, and desktop apps arrive in later phases under `apps/`.

## How it is built

- **Claude** does the reasoning: `claude-opus-5` for chat, `claude-sonnet-5` for bulk triage, `claude-haiku-4-5` for compression. Every analysis ends with a structured verdict (a JSON block validated against the shared zod schema), which the app renders as a verdict card and stores.
- **Everything Neo analyzes is treated as hostile.** Emails, texts, and web pages are written by the people Neo is judging, so they enter the model inside a trust-boundary envelope as evidence, never as instructions. See the threat model in [SECURITY.md](SECURITY.md#threat-model).
- **Multi-tenant from day one.** Every row carries a household `tenant_id`, every query is scoped in code, and Postgres row-level security backs it up.
- **Spend is capped.** Per-household monthly check and daily token caps, tunable by env var.
- **Stack:** pnpm and Turborepo, Next.js on Vercel, Neon Postgres, Auth.js, Inngest for background jobs (Phase 1).

## Self-hosting

The hosted service runs exactly this code. You can run your own instance on the free tiers of Vercel, Neon, Resend, and Inngest, paying only for Claude API usage. See [docs/self-hosting.md](docs/self-hosting.md) and [docs/deployment.md](docs/deployment.md).

## Contributing

Contributions are welcome. The flow is plan, then spec (`_specs/`), then a pull request with tests. Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Found a vulnerability? Please report it privately. See [SECURITY.md](SECURITY.md). Do not open a public issue.

## License

[MIT](LICENSE)
