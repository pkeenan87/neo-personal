# Development

Everything runs locally without API keys or a database account. Real services are opt-in, one variable at a time.

## Prerequisites

- **Node 22+** (`.nvmrc` pins 22).
- **pnpm**, at the version in the root `package.json` `packageManager` field. `corepack enable` installs it automatically.
- **Postgres 16+** (optional) for persistent conversations and real sign-in (Docker, Postgres.app, or a free Neon branch). See [Local database](#local-database). Without `DATABASE_URL` the app keeps conversations, usage, and audit events in memory for the life of the dev server, and only `DEV_AUTH_BYPASS` can sign you in.
- **gitleaks** (optional, for the pre-commit hook): `brew install gitleaks`, or a binary from <https://github.com/gitleaks/gitleaks/releases>.

## First run

```bash
pnpm install
cp .env.example apps/web/.env.local
pnpm dlx lefthook install
MOCK_MODE=true DEV_AUTH_BYPASS=true pnpm --filter @neo/web dev
```

Open <http://localhost:3000> and paste a link such as `https://paypa1-secure-login.com/verify` (phishing fixture) or `https://example.com/` (clean). Type a message containing `confirm-test` to try the confirmation flow. `DEV_AUTH_BYPASS=true` signs you in as a dev user (`dev@neo.local`) in a dev household, created in the database on first use when `DATABASE_URL` is set. It is refused whenever `NODE_ENV` is `production` or `VERCEL_ENV` is `production` or `preview`, and a "Dev auth bypass active" badge shows while it is on.

Next.js loads env files from the app directory (`apps/web/`), so `.env.local` goes there. Package tests read `process.env` directly and should not need a file.

## Mock mode

`MOCK_MODE=true` makes every external service deterministic and offline:

- **Claude**: the real agent loop (`@neo/core`) runs against a scripted model (`apps/web/lib/server/mock-model.ts`) that calls `check_url` for pasted links and answers with a verdict built from the tool's output. Tool calls, the trust-boundary envelope, persistence, usage caps and verdict storage all run for real.
- **URL analyzers** (Safe Browsing, VirusTotal, urlscan, RDAP, TLS, redirects): fixtures for the URLs in `MOCK_URLS` (`packages/tools/src/mock.ts`), a plausible clean result for anything else.
- **Resend**: with no `AUTH_RESEND_KEY`, magic links are printed to the dev server console. Result emails for forwarded mail are recorded in memory instead of sent.
- **Email/SMS analysis** (`analyze_email`, `analyze_sms`): real parsing and heuristics, URL checks from the fixtures above.
- **Triage** (forwarded mail): `runTriage` uses a deterministic mock client that builds the verdict from the analyzer's heuristic codes.
- **Artifacts**: without `BLOB_READ_WRITE_TOKEN` an in-memory blob store; without `NEO_MASTER_KEY` files are stored unencrypted (allowed only in MOCK_MODE or without a database). `GET /api/health` reports `artifacts: "memory"`.
- **Inbound mail and background jobs**: without `INNGEST_EVENT_KEY` the webhook runs the `email-received` job inline and waits for it.

Use it for UI work, tests, and CI. Usage is still recorded, so caps can be tested locally (`USAGE_CAP_MONTHLY_CHECKS=2`).

To use real services, set `MOCK_MODE=false` and `ANTHROPIC_API_KEY` (without a key `/api/agent` returns 503), then add analyzer keys as needed. Analyzer clients with no key return `{ skipped: "no_api_key" }` instead of failing, so a partial `.env.local` is fine.

## Phase 1 features locally

Everything below works with `MOCK_MODE=true DEV_AUTH_BYPASS=true` and no other variables (no database, Blob store, Resend or Inngest).

- **Uploads**: drop or paste a `.eml` file or a screenshot into the chat composer, or call the API directly:
  ```bash
  curl -s -F "file=@packages/tools/test/fixtures/email/paypal-lookalike.eml;type=message/rfc822" http://localhost:3000/api/artifacts
  # → { "artifacts": [{ "id": "…", "kind": "eml", … }] }
  ```
  Then send a chat turn with `{ "message": "", "attachments": [{ "id": "…" }] }` to `POST /api/agent`. Uploaded files are kept in memory until the dev server restarts.
- **Forward-to-address**: open `/settings/forwarding` to see the household address (on a placeholder `inbound.neo.localhost` domain without `NEO_INBOUND_DOMAIN`). Simulate Resend's webhook with the local-only bypass header, which works only in MOCK_MODE, on `localhost`, outside a Vercel deployment, and when `RESEND_WEBHOOK_SECRET` is unset. `data.raw` carries the message for the mock Resend client:
  ```bash
  curl -s http://localhost:3000/api/inbound/resend -H 'content-type: application/json' -H 'x-neo-mock-inbound: 1' \
    -d '{"type":"email.received","data":{"email_id":"em_1","from":"dev@neo.local","to":["<address from the settings page>"],"subject":"Fwd: test","raw":"From: dev@neo.local\r\nTo: …\r\nSubject: Fwd: test\r\n\r\nhttps://paypa1-secure-login.com/verify"}}'
  # → { "accepted": true }; the verdict then shows on /dashboard and /verdicts/<id>
  ```
  The forwarder must be a household member (`dev@neo.local` for the dev bypass user).
- **Inngest dev server** (optional, to watch the job's steps and retries): run `npx inngest-cli@latest dev` next to `pnpm --filter @neo/web dev`, and set `INNGEST_DEV=1` plus any non-empty `INNGEST_EVENT_KEY` in `apps/web/.env.local` so the webhook sends events instead of running the job inline. The dev server discovers the app at `http://localhost:3000/api/inngest` (open <http://localhost:8288>). The daily `artifacts-expire` cron can be triggered from its UI.
- **Dashboard and playbooks**: `/dashboard` lists every verdict (chat and forwarded); `/chat?playbook=clicked_link` starts a playbook.

## Commands

| Command | What it does |
|---|---|
| `pnpm typecheck` | `tsc --noEmit` in every package |
| `pnpm lint` | ESLint in every package |
| `pnpm test` | Vitest in every package (tests live in `<pkg>/test/`) |
| `pnpm build` | Builds packages to `dist/` and the web app to `.next/` |
| `pnpm turbo run typecheck lint test build` | Exactly what CI runs |
| `pnpm --filter @neo/web dev` | Web app dev server |
| `pnpm --filter @neo/core test -- --watch` | Watch one package's tests |
| `pnpm db:generate` / `pnpm db:migrate` | Drizzle migrations (`@neo/db`) |

## Local database

```bash
# Example with Docker
docker run -d --name neo-pg -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:17

# Create a non-superuser app role so RLS applies (see docs/self-hosting.md)
psql postgres://postgres:postgres@localhost:5432/postgres \
  -c "CREATE ROLE app_user LOGIN PASSWORD 'app_user' NOSUPERUSER NOBYPASSRLS;" \
  -c "CREATE DATABASE neo OWNER postgres;" \
  -c "GRANT CONNECT, TEMP ON DATABASE neo TO app_user;"
```

Run migrations as the owner role, apply the `app_user` grants from [self-hosting.md](self-hosting.md#database-roles-and-rls) (connected to the `neo` database), then run the app as `app_user`:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/neo pnpm db:migrate
# apps/web/.env.local
DATABASE_URL=postgres://app_user:app_user@localhost:5432/neo
NEO_DB_DRIVER=pg
```

## Git hooks (pre-commit secret scan)

The repo uses [lefthook](https://github.com/evilmartians/lefthook). Install the hooks once per clone:

```bash
pnpm dlx lefthook install
```

On every commit, `lefthook.yml` runs `gitleaks git --pre-commit --staged --redact` (the current form of `gitleaks protect --staged`) against staged changes using `.gitleaks.toml`. If `gitleaks` is not installed, the hook prints an install hint and lets the commit through. CI runs the same scan over full history and **blocks** the merge, so a missed local scan only delays the failure.

If the hook flags something:

1. Remove the secret from the staged file (`git restore --staged <file>` and edit).
2. If it was ever pushed anywhere, **rotate it**. Removing it from history is not enough.
3. If it is a genuine false positive (a synthetic fixture), move it under a `test/fixtures/` directory, or add a narrow entry to `.gitleaks.toml` in its own PR with a justification.

Never bypass the hook with `--no-verify` to commit a real credential.

## Adding an environment variable

1. Add it to `.env.example`, in the right group, with a comment (what it is, allowed values, default).
2. Make the code work when it is unset (mock or skip), so CI and fresh clones still pass.
3. If it is a secret, add it to the table in `docs/self-hosting.md` and to Vercel per environment.

## Conventions

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the plan, spec, PR flow, commit format, and the SHA-pinning rule for Actions. See [contracts.md](contracts.md) for package interfaces.
