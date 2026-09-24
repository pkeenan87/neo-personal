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
