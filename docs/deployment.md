# Deployment (Vercel)

How the hosted service and self-hosted instances deploy `apps/web`. For first-time self-hosting, start with [self-hosting.md](self-hosting.md).

## Project setup

Create one Vercel project connected to the GitHub repository.

| Setting | Value | Where |
|---|---|---|
| Root Directory | `apps/web` | Project Settings, Build and Deployment (dashboard only; `vercel.json` cannot set it) |
| Include files outside the Root Directory | Enabled (default for monorepos) | Same page. Needed for `packages/*`. |
| Framework Preset | Next.js | From `vercel.json` |
| Install Command | `pnpm install --frozen-lockfile` | From `vercel.json` |
| Build Command | `pnpm turbo run build --filter=@neo/web` | From `vercel.json`. Turbo builds `@neo/*` dependencies first. |
| Node.js Version | 22.x | Project Settings, matches `engines.node` |
| Fluid compute | On | Project Settings, Functions |

Vercel detects pnpm and its version from the `packageManager` field and the lockfile.

### Where `vercel.json` must live

Vercel reads `vercel.json` from the project's **Root Directory**. With Root Directory set to `apps/web`, the file Vercel applies is `apps/web/vercel.json`, and paths in it (`functions`) are relative to `apps/web`. The repository-root `vercel.json` is the canonical copy of this configuration (headers, function durations, build commands) with paths already written relative to `apps/web`; `apps/web/vercel.json` must match it. If they diverge, the one in `apps/web` wins.

Function duration is also declared in code: `export const maxDuration = 300` in `app/api/agent/route.ts` (Next.js route segment config). Keep both in sync.

### Function limits

`/api/agent` streams a full agent turn (multiple Claude calls and tool calls) as NDJSON. It is set to `maxDuration: 300` seconds, the Hobby maximum. On Pro it can go to 800. Streaming keeps the client informed during long tool chains. Anything that must outlive a request goes to Inngest, never a longer function. `/api/inngest` (Inngest calls it to run each step) also has `maxDuration: 300`.

### Security headers

`vercel.json` sets on every response: HSTS (2 years, subdomains, no preload yet), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, a restrictive `Permissions-Policy`, and `Cache-Control: no-store` on `/api/*`.

The Content Security Policy ships as **`Content-Security-Policy-Report-Only`**. Watch the browser console on preview deployments for violations, then move to an enforced, nonce-based CSP in Next.js middleware once the app's needs are known. Add `preload` to HSTS only after the production domain is final.

## Environments

| Vercel environment | Branch | Database | Keys |
|---|---|---|---|
| Production | `main` | Neon main branch, `app_user` role | Production keys |
| Preview | every PR branch | Neon branch per preview (below) | Separate low-limit keys, or none with `MOCK_MODE=true` |
| Development | local (`vercel env pull`) | Local Postgres or a Neon dev branch | Your own |

Set variables per environment in Project Settings, Environment Variables. Mark secrets as **Sensitive**. `vercel env pull apps/web/.env.local` fetches Development values for local use.

## Preview deployments with Neon branching

Each pull request gets a preview URL. With the Neon integration's **preview branching** enabled, each preview deployment gets its own Neon branch forked from the main branch, and `DATABASE_URL` for that deployment points at it. Migrations can run against the branch without touching production.

Setup:

1. Install Neon from the Vercel Marketplace and connect the project.
2. In the integration settings, enable creating a database branch for each preview deployment.
3. Make sure the `app_user` role exists on the parent branch, since branches inherit roles and grants. Set the preview `NEO_DATABASE_URL` to the `app_user` connection string for the branch (the integration-managed `DATABASE_URL` stays on the owner role and is used only by migrations).
4. Run migrations as part of the preview build, or manually against the branch. **Do not** run migrations automatically against production from a build; run them deliberately before promoting.
5. Neon deletes preview branches when the integration's cleanup runs; old branches count against plan limits.

Preview-specific settings:

- `MOCK_MODE=true` unless you are testing a real integration, so previews cannot spend API budget.
- Lower usage caps (`USAGE_CAP_MONTHLY_CHECKS=10`).
- `DEV_AUTH_BYPASS` stays **off**. Previews are public URLs. Use Vercel Deployment Protection if previews need to be private.
- Google OAuth does not accept wildcard redirect URIs, so use magic-link sign-in on previews.

## Phase 1 services

Deploy order for Phase 1 (details and commands in `CHECKLIST.md` §9 and [self-hosting.md](self-hosting.md)):

1. **Migration first.** Run `0003_phase1` as the owner role before deploying the Phase 1 code: `MIGRATION_DATABASE_URL=<owner url> pnpm db:migrate`. It is additive (new columns with defaults or backfills, new tables and functions), so the Phase 0 deployment keeps working against the migrated schema and a rollback is safe. It grants `EXECUTE` on its three `security definer` functions to `app_user` when that role exists; otherwise re-run `packages/db/sql/create-app-user.sql`.
2. **Vercel Blob**: create a private Blob store for the project (`vercel blob store add neo-artifacts`); it sets `BLOB_READ_WRITE_TOKEN`, or `BLOB_STORE_ID` for an OIDC-connected store (both work).
3. **`NEO_MASTER_KEY`**: `openssl rand -base64 32`, added as a sensitive env var for Production (and Preview if previews use Blob). Required on production: without it `/api/health` reports `artifacts: "unconfigured"` and uploads return 503. Losing it makes stored artifacts unreadable.
4. **Resend inbound**: verify the inbound subdomain (MX records), set `NEO_INBOUND_DOMAIN`, create a webhook for `email.received` at `https://<domain>/api/inbound/resend`, and set its signing secret as `RESEND_WEBHOOK_SECRET`. The job fetches each message with `GET /emails/receiving/{id}` and downloads the raw MIME from the signed URL in that response, using `RESEND_API_KEY` (defaults to `AUTH_RESEND_KEY`).
5. **Inngest**: install the Vercel Marketplace integration (sets `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`) and sync the app URL `https://<domain>/api/inngest` in the Inngest dashboard (the integration re-syncs on each deploy). Functions: `email-received` and the daily `artifacts-expire` cron (`0 4 * * *` UTC), which Inngest schedules, not Vercel Cron.

`GET /api/health` shows `artifacts: "ok"` and `inbound: "ok"` once all of this is in place.

## Vercel Cron (placeholder)

Phase 1 needs no Vercel Cron: scheduled work runs as Inngest cron functions. If Vercel Cron routes arrive later (weekly digest, breach re-checks) they will be:

```json
{
  "crons": [
    { "path": "/api/cron/weekly-digest", "schedule": "0 13 * * 1" }
  ]
}
```

- Cron routes must check `Authorization: Bearer ${CRON_SECRET}` and reject everything else.
- Cron handlers only enqueue Inngest events; the work runs in Inngest, not inside the cron invocation.
- Hobby plans run cron at most once per day, with imprecise timing.

## Promoting and rolling back

- Production deploys on merge to `main` after **All checks passed** is green.
- Roll back with Vercel **Instant Rollback** to the previous production deployment. Database migrations must be backward compatible for one release so a rollback does not break the schema.

### Inngest sync after deploys

Inngest only runs functions of an app it has synced. The Vercel integration is supposed to sync on every deploy; if the Inngest dashboard (Apps) shows no functions or a stale "Last synced at", trigger a sync by hand. The serve route registers itself with Inngest Cloud on a `PUT`:

```
curl -X PUT https://www.neoshield.dev/api/inngest
```

It answers `{"message":"Successfully registered"}`. Do this after any deploy that adds or changes a function. Events sent while no function was registered do not run retroactively; replay them from Inngest → Events → the event → "Replay event".
