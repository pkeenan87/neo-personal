# Contributing to Neo

Thanks for helping. Neo is a small, security-sensitive project, so the process is deliberate: plan, spec, then a pull request with tests.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). **Security vulnerabilities go through [SECURITY.md](SECURITY.md), never a public issue or PR.**

## Setup

Node 22+, pnpm (the version in `package.json` `packageManager`; `corepack enable` picks it up). No API keys are required.

```bash
pnpm install
cp .env.example .env.local
pnpm dlx lefthook install          # pre-commit secret scan (see docs/development.md)
MOCK_MODE=true DEV_AUTH_BYPASS=true pnpm --filter @neo/web dev
```

Full details: [docs/development.md](docs/development.md).

## How a change lands

1. **Plan** (for anything larger than a bug fix): check `_plans/phase-0-and-roadmap.md`. If the change is not on the roadmap, open a feature request first so we can agree it belongs.
2. **Spec**: for any non-trivial feature, add `_specs/<feature>.md` from [`_specs/template.md`](_specs/template.md): summary, functional requirements, edge cases, acceptance criteria, testing guidelines. A spec can be its own PR. Specs are public, like the plan.
3. **Interfaces**: if you change a package's public interface, update [`docs/contracts.md`](docs/contracts.md) in the same PR, before the code. It is the source of truth.
4. **Branch and PR**: branch from `main` (`feat/<name>`, `fix/<name>`, `docs/<name>`), open a PR using the template, link the spec.
5. **CI must be green**: the required check is **All checks passed**, which covers typecheck, lint, test, build, CodeQL, and gitleaks.

`main` is protected: no direct pushes, no force pushes. PRs are squash-merged.

## Rules that are enforced in review

- **Tests are required.** New behaviour ships with Vitest tests in the package's `test/` directory. Bug fixes ship with a test that fails before the fix. Tests run with `MOCK_MODE=true` and no network.
- **No secrets, ever.** Every external API needs a mock mode and must work (by returning `{ skipped: "no_api_key" }` or fixtures) when its key is unset. Every new env var goes in `.env.example` with a comment.
- **Tenant scoping.** Every query on a tenant table goes through `tenantScoped()`. Never take a tenant id from the request body.
- **Untrusted content.** Emails, SMS, pages, and tool results reach the model only through `wrapToolResult`.
- **Outbound fetches** to user-supplied URLs go through the SSRF guard.
- **No `any`.** Use real types or `unknown` and narrow.
- **Claude models and parameters**: see `CLAUDE.md` and `docs/contracts.md` (adaptive thinking, no `budget_tokens`, no prefill).

## GitHub Actions: SHA pinning

Every `uses:` in `.github/workflows/` is pinned to a full commit SHA with the version as a trailing comment. Tags can be re-pointed upstream; SHAs cannot.

```yaml
- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1   # correct
- uses: actions/checkout@v7                                                      # rejected
```

Resolve a tag to a commit SHA yourself; never copy one from a blog post or guess:

```bash
gh api repos/{owner}/{repo}/git/refs/tags/{tag} --jq '.object.type + " " + .object.sha'
# If the type is "tag" (an annotated tag), dereference it to the commit:
gh api repos/{owner}/{repo}/git/tags/{sha} --jq '.object.sha'
```

Give each job the minimum `permissions:`. Container images used in workflows are pinned by digest.

## Commit messages

Emoji conventional commits, one line that fits `git log --oneline`, body for the **why**:

```
<emoji> <type>(<scope>): <summary>
```

| Emoji | Type |
|---|---|
| ✨ | feat |
| 🐛 | fix |
| 🔒 | security |
| 📝 | docs |
| 🧪 | test |
| ♻️ | refactor |
| ⚡ | perf |
| 👷 | ci |
| ⬆️ | deps |
| 🔧 | chore / config |

Examples: `✨ feat(tools): add RDAP domain age lookup`, `🔒 fix(tools): re-check resolved IP on every redirect hop`.

## Licensing

Neo is MIT licensed. By contributing you agree your contribution is licensed under the MIT License. Only submit code you have the right to license that way.
