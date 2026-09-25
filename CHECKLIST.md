# Owner checklist

Things only you can do: accounts, credentials, and decisions. Everything is ordered so each block unblocks the next. Local env values go in `apps/web/.env.local` (gitignored). Production values go in Vercel project settings. Never put a real value in `.env.example`.

Status as of 2026-09-25: Phase 0 is complete and verified in production at https://neo-sable-ten.vercel.app. Google sign-in works for test users, Neon Postgres runs under the `app_user` RLS role, Safe Browsing, VirusTotal, and urlscan keys are live, and the first production URL check persisted a conversation, usage event, and verdict. Remaining blockers for a public launch: a domain, Resend magic links, a privacy policy, and publishing the Google consent screen.

## 1. Right now (free, unblocks local testing)

- [x] In `apps/web/.env.local` set `MOCK_MODE=false` and `DEV_AUTH_BYPASS=true` so the dev server uses the real agent without a database.
- [x] Get a free **Google Safe Browsing** API key (Google Cloud Console, enable "Safe Browsing API", create an API key). Set `GOOGLE_SAFE_BROWSING_API_KEY`. Note: the v4 Lookup API is for non-commercial use; switch to Web Risk before charging money.
- [x] Get a free **VirusTotal** API key (virustotal.com, sign up, API key in profile). Set `VIRUSTOTAL_API_KEY`. Free tier is 4 requests/minute, 500/day.
- [x] Decide `VIRUSTOTAL_SUBMIT` (production: false). Default `true` submits unknown URLs to VirusTotal, where other VT users can see them (password-reset links included). Recommended: set `VIRUSTOTAL_SUBMIT=false` until there is a per-tenant opt-in.
- [ ] Set a spend limit on the Anthropic key in the Console (Settings, Limits) so a bug cannot burn the $20 balance.
- [x] Optional: a free **urlscan.io** key (key set; still disabled in production) for screenshots. Set `URLSCAN_API_KEY` and `URLSCAN_ENABLED=true`. Adds up to 25 seconds per URL check.

## 2. Database (unblocks real sign-in, persistence, usage caps)

- [x] Create a **Neon** project (free tier). Copy the owner connection string.
- [x] Run migrations as the owner:
  ```
  MIGRATION_DATABASE_URL='<owner connection string>' pnpm db:migrate
  ```
- [x] Create the non-superuser app role by running `packages/db/sql/create-app-user.sql` against the database as the owner (SQL editor in Neon). Do this in SQL, not the Neon console, because console-created roles can bypass row-level security. Pick a strong password.
- [x] Done via `NEO_DATABASE_URL` on Vercel (app role, pooled host); the Neon integration keeps `DATABASE_URL` on the owner for migrations. Verified with:
  ```sql
  select rolname, rolsuper, rolbypassrls from pg_roles where rolname = 'app_user';
  ```
  Both flags must be false.
- [ ] Start the dev server and confirm conversations survive a restart.
- [x] Role name unified to `app_user` everywhere (2026-09-24).

## 3. Authentication (unblocks turning off the dev bypass)

- [x] Generate `AUTH_SECRET`:
  ```
  openssl rand -hex 32
  ```
- [x] **Google OAuth** (done 2026-09-25 in project `neo-personal-509701`: consent screen in Testing, web client with production and localhost redirect URIs, you as test user). Original notes: Authorized redirect URI for local dev: `http://localhost:3000/api/auth/callback/google`. Add the production and preview URLs later. Set `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET`. Configure the OAuth consent screen (app name Neo, your support email, privacy policy URL once the site exists). Publishing status can stay "Testing" with your own account as a test user until launch.
- [ ] **Resend** account for magic links. Add and verify a sending domain (needs the domain from section 5, or use Resend's test domain for local only). Set `AUTH_RESEND_KEY` and `EMAIL_FROM` (for example `Neo <sign-in@yourdomain>`).
- [ ] Sign in locally with a magic link once Resend is configured (Google sign-in verified in production). Confirm a household tenant is created on first sign-in.

## 4. Vercel deployment

- [x] Create a Vercel project from `pkeenan87/neo-personal`. Set **Root Directory** to `apps/web`. Framework Next.js. Install command `pnpm install`, build command `pnpm turbo run build --filter=@neo/web` (already in `apps/web/vercel.json`).
- [x] Add environment variables for Production and Preview: `ANTHROPIC_API_KEY`, `AUTH_SECRET`, `AUTH_URL` (production URL), `AUTH_TRUST_HOST=true`, `DATABASE_URL`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_RESEND_KEY`, `EMAIL_FROM`, `GOOGLE_SAFE_BROWSING_API_KEY`, `VIRUSTOTAL_API_KEY`, `VIRUSTOTAL_SUBMIT=false`, `MOCK_MODE=false`, `DEV_AUTH_BYPASS=false`, `USAGE_CAP_MONTHLY_CHECKS`, `USAGE_CAP_DAILY_TOKENS`.
- [x] Vercel production URL is in the Google OAuth redirect URIs.
- [x] Deployed; `/api/health` returns `mock: false`. Signed in with Google and ran the first production URL check on 2026-09-25: conversation, usage event, and verdict row all persisted under RLS.
- [ ] Optional: Neon branch per preview deployment via the Vercel Neon integration, so previews do not touch production data.
- [x] Enable the Vercel GitHub integration so PRs get preview deployments.

## 5. Domain and public identity

- [ ] Publish the Google consent screen (Audience page) once a privacy policy URL exists; until then only test users can sign in.
- [ ] Small follow-up: map Google's `email_verified` claim into the Auth.js user record (currently left empty by the default profile mapper).

- [ ] Register the domain for Neo (blocks the forward-to-address in Phase 1, Resend sending domain, OAuth consent screen, store listings).
- [ ] Point it at Vercel and set `AUTH_URL` to it.
- [ ] Write a privacy policy page (required by Google OAuth verification, Chrome Web Store, and the app stores later).
- [ ] Update `SECURITY.md` and `CODE_OF_CONDUCT.md` with a real contact email, or a role address on the new domain.

## 6. GitHub housekeeping

- [ ] Confirm you are happy with the main branch ruleset (PRs required, zero approvals, "All checks passed" required, admins can bypass). Adjust at Settings, Rules.
- [ ] Add a repo description, topics (`security`, `phishing`, `claude`, `nextjs`), and a social preview image.
- [ ] Decide whether to archive or add a README note to the old public `pkeenan87/Neo` snapshot so people do not confuse the two.
- [ ] Watch the first Dependabot PRs and merge them once CI passes.

## 7. Work repo follow-ups

- [ ] Diff the private work Neo repo against `~/Work/Neo` (June 2026) to see if anything in the lifted files changed. If so, tell me which files and I will port the changes.
- [ ] Port the injection-guard regex fix back to the work repo. The `encoded_payload` and `SYSTEM:` role-header patterns in `web/lib/injection-guard.ts` are quadratic on long input (about 400 ms per 20K characters). The fixed versions are in `packages/core/src/injection-guard.ts` here.

## 8. Decisions still open from the plan

- [ ] Inbound email provider for Phase 1: Resend (assumed) or Postmark.
- [ ] Usage cap launch numbers once you have seen a week of real per-check costs. Current defaults: 50 checks/month, 300,000 tokens/day per household.
- [x] App DB role is `app_user`.
