# Development

Everything runs locally without API keys or a database account. Real services are opt-in, one variable at a time.

## Prerequisites

- **Node 22+** (`.nvmrc` pins 22).
- **pnpm**, at the version in the root `package.json` `packageManager` field. `corepack enable` installs it automatically.
- **Postgres 16+** for conversation storage and sign-in (Docker, Postgres.app, or a free Neon branch). See [Local database](#local-database).
- **gitleaks** (optional, for the pre-commit hook): `brew install gitleaks`, or a binary from <https://github.com/gitleaks/gitleaks/releases>.

## First run

```bash
pnpm install
cp .env.example apps/web/.env.local
pnpm dlx lefthook install
MOCK_MODE=true DEV_AUTH_BYPASS=true pnpm --filter @neo/web dev
```

Open <http://localhost:3000>. `DEV_AUTH_BYPASS=true` signs you in as a seeded dev user in a seeded household. It is refused whenever `NODE_ENV` is `production` or `VERCEL_ENV` is `production` or `preview`.

Next.js loads env files from the app directory (`apps/web/`), so `.env.local` goes there. Package tests read `process.env` directly and should not need a file.

## Mock mode

`MOCK_MODE=true` makes every external client (Claude, Safe Browsing, VirusTotal, urlscan, RDAP, Resend) return deterministic fixtures for a fixed set of test URLs, and makes no network calls. Use it for UI work, tests, and CI.

To exercise one real service, set `MOCK_MODE=false` and fill in only that key. Clients with no key return `{ skipped: "no_api_key" }` instead of failing, so a partial `.env.local` is fine.

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
  -c "CREATE ROLE neo_app LOGIN PASSWORD 'neo_app' NOSUPERUSER NOBYPASSRLS;" \
  -c "CREATE DATABASE neo OWNER postgres;" \
  -c "GRANT CONNECT, TEMP ON DATABASE neo TO neo_app;"
```

Run migrations as the owner role, apply the `neo_app` grants from [self-hosting.md](self-hosting.md#database-roles-and-rls) (connected to the `neo` database), then run the app as `neo_app`:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/neo pnpm db:migrate
# apps/web/.env.local
DATABASE_URL=postgres://neo_app:neo_app@localhost:5432/neo
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
