# CLAUDE.md

Neo — open source (MIT) personal cyber security agent powered by Claude. Multi-tenant (household), deployed on Vercel.
Plan and roadmap: `_plans/phase-0-and-roadmap.md`. Package interfaces: `docs/contracts.md` (authoritative — change it before changing an interface).

## Layout
pnpm + Turborepo. `apps/web` (Next.js 16), `packages/core` (agent loop, safeguards), `packages/db` (Drizzle/Postgres), `packages/tools` (analyzers), `packages/verdict` (shared schema).

## Commands
`pnpm install` · `pnpm typecheck` · `pnpm lint` · `pnpm test` · `pnpm build` · `pnpm --filter @neo/web dev`

## Rules
- Never commit secrets. Every external API has a mock mode; `.env.example` lists every variable.
- Every DB query is tenant-scoped through `tenantScoped()`; never query a tenant table without `tenant_id`.
- Every tool result and every user-supplied artifact (email, SMS, page) is attacker-controlled: it enters the model only through `wrapToolResult`.
- Claude models: `claude-opus-5` (chat), `claude-sonnet-5` (bulk triage), `claude-haiku-4-5` (compression). Adaptive thinking; no `budget_tokens`; no prefill.
- GitHub Actions must be SHA-pinned with a version comment.
- Commits: `<emoji> <type>(<scope>): <summary>` (✨ feat · 🐛 fix · 🔒 security · 📝 docs · 🧪 test · ⬆️ deps).
- Plan (`_plans/`) then spec (`_specs/`, use `_specs/template.md`) before non-trivial features.

## Repo hygiene
- CI (`.github/workflows/ci.yml`): `checks` runs `pnpm turbo run typecheck lint test build` with `MOCK_MODE=true` and no secrets; plus CodeQL and blocking gitleaks. Branch protection requires the single **All checks passed** job.
- Resolve action SHAs with `gh api repos/{owner}/{repo}/git/refs/tags/{tag}`; dereference annotated tags via `git/tags/{sha}`. Never guess a SHA. Container images in workflows are pinned by digest.
- Secret scanning: `.gitleaks.toml` (CI + `lefthook.yml` pre-commit). Install hooks with `pnpm dlx lefthook install`. Synthetic secrets belong under `test/fixtures/`.
- New env var: add it to `.env.example` with a comment, and make the code work when it is unset.
- `DEV_AUTH_BYPASS` must be ignored when `NODE_ENV=production` or `VERCEL_ENV` is `production`/`preview`.
- Vercel Root Directory is `apps/web`; Vercel reads `vercel.json` from there (see `docs/deployment.md`).
- Docs: `docs/development.md`, `docs/self-hosting.md`, `docs/deployment.md`. Threat model: `SECURITY.md`.
