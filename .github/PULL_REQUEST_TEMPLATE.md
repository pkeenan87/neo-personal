<!-- Thanks for the PR. Delete any section that does not apply. -->

## Summary

<!-- 1-3 sentences: what changes and why. -->

Spec: `_specs/<slug>.md` <!-- required for non-trivial features -->
Plan: `_plans/<slug>.md` <!-- if applicable -->

## Test plan

- [ ] Tests added or updated under the affected package's `test/`
- [ ] `pnpm typecheck` clean
- [ ] `pnpm lint` clean
- [ ] `pnpm test` clean
- [ ] Ran it locally with `MOCK_MODE=true` (no real API keys required)
- [ ] Manual verification (steps below)

## Security considerations

<!-- Tick any that apply and explain inline. If none apply, write "N/A" and why. -->

- [ ] Touches authentication, sessions, or tenant membership
- [ ] Adds or changes a database query (is it tenant-scoped via `tenantScoped()`?)
- [ ] Feeds user-supplied or external content to the model (is it wrapped with `wrapToolResult`?)
- [ ] Makes an outbound HTTP request to a user-supplied URL or host (SSRF guard?)
- [ ] Adds or changes an env var or secret (`.env.example` updated? mock mode still works without it?)
- [ ] Adds or changes log fields (PII allowlist / `hashPii`)
- [ ] Changes usage caps, rate limits, or anything that affects API spend
- [ ] Touches `.github/` (actions SHA-pinned with a version comment?)

## Checklist

- [ ] Commit messages follow `<emoji> <type>(<scope>): <summary>`
- [ ] Docs updated (`README.md`, `docs/`, `docs/contracts.md` if an interface changed)
