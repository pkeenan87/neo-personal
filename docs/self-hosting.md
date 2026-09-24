# Self-hosting Neo

The hosted Neo service runs the same code as this repository. You can run your own instance for a household on free tiers.

> **Status:** pre-alpha (Phase 0). Only URL checks in chat work end to end. Forward-to-address email, background jobs, and notifications arrive in Phase 1. Expect breaking changes, including database migrations, until a tagged release.

## What you need

| Service | Used for | Free tier |
|---|---|---|
| [Vercel](https://vercel.com) | Hosting the Next.js app, Cron | Hobby (functions up to 300s) |
| [Neon](https://neon.tech) | Postgres (install from the Vercel Marketplace to get `DATABASE_URL` wired automatically) | Free plan |
| [Anthropic](https://console.anthropic.com) | Claude API | Pay as you go (this is the one real cost) |
| [Google Cloud](https://console.cloud.google.com) | Google sign-in, Safe Browsing API key | Free |
| [Resend](https://resend.com) | Magic-link sign-in email; inbound email from Phase 1 | Free plan, needs a verified domain |
| [Inngest](https://www.inngest.com) | Background jobs (Phase 1+) | Free plan |
| [VirusTotal](https://www.virustotal.com), [urlscan.io](https://urlscan.io) | URL reputation, screenshots | Free API keys, rate limited |

Hobby plans on Vercel are for non-commercial use. A private household instance fits; a service for others needs a paid plan.

## Steps

1. **Fork** this repository on GitHub.
2. **Create a Vercel project** from the fork. Set **Root Directory** to `apps/web` (dashboard setting) and leave build settings to `vercel.json`. See [deployment.md](deployment.md) for detail.
3. **Add Neon** from Vercel's Marketplace (Storage tab) and link it to the project. This sets `DATABASE_URL` for each environment. Enable preview branching if you want per-PR databases.
4. **Create the application role** (see [Database roles and RLS](#database-roles-and-rls) below) and replace `DATABASE_URL` in Vercel with the `neo_app` connection string. Keep the owner connection string for migrations only.
5. **Run migrations** from your machine with the owner connection string:
   ```bash
   pnpm install
   DATABASE_URL='<owner connection string>' pnpm db:migrate
   ```
6. **Google OAuth**: create an OAuth client (Web application). Authorized redirect URI: `https://<your-domain>/api/auth/callback/google`. Copy the ID and secret.
7. **Resend**: verify a sending domain, create an API key, pick an `EMAIL_FROM` on that domain.
8. **Set environment variables** in Vercel (Production, and separately Preview) from the table below. Generate `AUTH_SECRET` with `openssl rand -base64 32`.
9. **Deploy.** Visit `/api/health`, then sign in. The first sign-in creates your household with you as owner.
10. **Set usage caps** to match your budget (`USAGE_CAP_MONTHLY_CHECKS`, `USAGE_CAP_DAILY_TOKENS`). They apply per household.
11. *(Phase 1+)* Install the Inngest integration from the Vercel Marketplace, which sets `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY`.

## Environment variables

`.env.example` is the complete, commented list. For a production instance:

| Variable | Required | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Set a spend limit in the Anthropic console too. |
| `NEO_AGENT_MODEL`, `NEO_COMPRESSION_MODEL`, `NEO_TRIAGE_MODEL` | No | Defaults: `claude-opus-5`, `claude-haiku-4-5`, `claude-sonnet-5`. |
| `NEO_AGENT_EFFORT`, `NEO_ENABLE_FALLBACKS` | No | Defaults `medium`, `true`. |
| `DATABASE_URL` | Yes | The **`neo_app`** role, not the owner. `?sslmode=require` on Neon. |
| `NEO_DB_DRIVER` | No | `neon` on Vercel + Neon (auto-detected). |
| `AUTH_SECRET` | Yes | Random 32 bytes. Rotating it signs everyone out. |
| `AUTH_URL` | No | Unset on Vercel. Set it behind other proxies. |
| `AUTH_TRUST_HOST` | Yes | `true` on Vercel. |
| `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` | One sign-in method required | Google sign-in. |
| `AUTH_RESEND_KEY`, `EMAIL_FROM` | One sign-in method required | Magic-link sign-in. |
| `GOOGLE_SAFE_BROWSING_API_KEY` | Recommended | Skipped if unset. |
| `VIRUSTOTAL_API_KEY` | Recommended | Skipped if unset. 4 req/min on free tier. |
| `URLSCAN_API_KEY`, `URLSCAN_ENABLED` | Optional | Leave `URLSCAN_ENABLED=false` unless you accept that submitted URLs may be visible on urlscan.io. |
| `USAGE_CAP_MONTHLY_CHECKS`, `USAGE_CAP_DAILY_TOKENS` | No | Defaults 50 and 300000 per household. |
| `MOCK_MODE` | Yes | **`false`** in production. |
| `DEV_AUTH_BYPASS` | No | Leave unset/`false`. Refused in production regardless. |
| `INJECTION_GUARD_MODE` | No | `monitor` (default) or `block`. |
| `LOG_LEVEL` | No | `info`. |

## Database roles and RLS

Neo scopes every query by `tenant_id` in code **and** enables Postgres row-level security as a second layer. RLS is **silently bypassed** for superusers, roles with `BYPASSRLS`, and (unless `FORCE ROW LEVEL SECURITY` is set) the table owner. Neon's default role owns the tables it creates, so do not run the app with it.

Create a dedicated role for the app, as the owner:

```sql
CREATE ROLE neo_app LOGIN PASSWORD '<strong password>' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
GRANT USAGE ON SCHEMA public TO neo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO neo_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO neo_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO neo_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO neo_app;
```

Run migrations as the owner. Run the app as `neo_app`. You can confirm isolation with:

```sql
SET ROLE neo_app;
SELECT count(*) FROM conversations;   -- expect 0 without app.tenant_id set
```

## Operating it

- **Updates:** pull from upstream into your fork, run migrations with the owner string, then let Vercel deploy.
- **Backups:** Neon keeps point-in-time history on its free plan for a limited window. Take your own `pg_dump` if the data matters.
- **Secrets:** use Vercel's Sensitive environment variables. Give Preview deployments different (or no) API keys.
- **Security issues** in Neo itself: see [SECURITY.md](../SECURITY.md).
