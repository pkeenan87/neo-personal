# Self-hosting Neo

The hosted Neo service runs the same code as this repository. You can run your own instance for a household on free tiers.

> **Status:** pre-alpha. Expect breaking changes, including database migrations, until a tagged release.

What a Phase 1 instance does: chat checks of links, pasted emails and text messages, uploaded `.eml` files and screenshots; a private forwarding address per household (`check-…@<your inbound domain>`) that analyzes forwarded emails in the background and emails the result back; a dashboard with history; and guided incident playbooks ("I clicked a link", "I sent money", …).

## What you need

| Service | Used for | Free tier |
|---|---|---|
| [Vercel](https://vercel.com) | Hosting the Next.js app, Cron | Hobby (functions up to 300s) |
| [Neon](https://neon.tech) | Postgres (install from the Vercel Marketplace to get `DATABASE_URL` wired automatically) | Free plan |
| [Anthropic](https://console.anthropic.com) or [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) | Model calls (see [Model access](#model-access)) | Pay as you go (this is the one real cost) |
| [Google Cloud](https://console.cloud.google.com) | Google sign-in, Safe Browsing API key | Free |
| [Resend](https://resend.com) | Magic-link sign-in email, inbound email (forwarding address), result emails | Free plan, needs a verified domain |
| [Inngest](https://www.inngest.com) | Background jobs: forwarded-email analysis, artifact expiry | Free plan |
| [Vercel Blob](https://vercel.com/docs/storage/vercel-blob) | Encrypted evidence files (uploads, forwarded emails) | Hobby includes a free allowance |
| [VirusTotal](https://www.virustotal.com), [urlscan.io](https://urlscan.io) | URL reputation, screenshots | Free API keys, rate limited |

Hobby plans on Vercel are for non-commercial use. A private household instance fits; a service for others needs a paid plan.

## Steps

1. **Fork** this repository on GitHub.
2. **Create a Vercel project** from the fork. Set **Root Directory** to `apps/web` (dashboard setting) and leave build settings to `vercel.json`. See [deployment.md](deployment.md) for detail.
3. **Add Neon** from Vercel's Marketplace (Storage tab) and link it to the project. This sets `DATABASE_URL` for each environment. Enable preview branching if you want per-PR databases.
4. **Create the application role** (see [Database roles and RLS](#database-roles-and-rls) below) and add `NEO_DATABASE_URL` in Vercel with the `app_user` connection string (pooled host). The integration keeps managing `DATABASE_URL` with the owner role; the app prefers `NEO_DATABASE_URL`, and migrations use the owner string.
5. **Run migrations** from your machine with the owner connection string (this includes `0005_desktop_tokens` and `0006_desktop_auth`, which the desktop sign-in for the Omarchy plugin needs):
   ```bash
   pnpm install
   DATABASE_URL='<owner connection string>' pnpm db:migrate
   ```
6. **Google OAuth**: create an OAuth client (Web application). Authorized redirect URI: `https://<your-domain>/api/auth/callback/google`. Copy the ID and secret.
7. **Resend**: verify a sending domain, create an API key, pick an `EMAIL_FROM` on that domain.
8. **Set environment variables** in Vercel (Production, and separately Preview) from the table below. Generate `AUTH_SECRET` with `openssl rand -base64 32`.
9. **Artifact encryption key.** Generate `NEO_MASTER_KEY` with `openssl rand -base64 32` and store it as a Sensitive variable. Evidence files are encrypted per household with keys derived from it; losing it makes stored evidence unreadable, and production refuses uploads without it. Optionally set `NEO_ARTIFACT_RETENTION_DAYS` (default 30).
10. **Vercel Blob**: create a Blob store (Storage tab) and connect it to the project. This sets `BLOB_READ_WRITE_TOKEN` (or `BLOB_STORE_ID` for OIDC-connected stores; both work). Files are stored private and encrypted.
11. **Inngest**: install the Inngest integration from the Vercel Marketplace. It sets `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` and syncs the app's functions from `/api/inngest` on each deploy.
12. **Resend inbound** (the forwarding address):
    1. Pick an inbound domain you control, usually a subdomain such as `inbound.example.com`, and set `NEO_INBOUND_DOMAIN` to it.
    2. In Resend, add the domain for receiving and create the MX record Resend shows at your DNS provider.
    3. Add a webhook for the `email.received` event pointing at `https://<your-domain>/api/inbound/resend`, and copy its signing secret into `RESEND_WEBHOOK_SECRET`.
    4. The same Resend API key reads received messages and sends result emails: `AUTH_RESEND_KEY` (or `RESEND_API_KEY`, which takes precedence). `EMAIL_FROM` must be on a verified sending domain.
    5. Optionally cap forwarded messages per address with `NEO_INBOUND_RATE_LIMIT_PER_HOUR` (default 30).
13. **Deploy.** Visit `/api/health`, then sign in. The first sign-in creates your household with you as owner; signed-in visits to `/` go to `/dashboard`.
14. **Try forwarding**: open Settings → Forwarding, copy your household's address, and forward a test email to it. The verdict appears on the dashboard and is emailed back to the forwarder.
15. **Set usage caps** to match your budget (`USAGE_CAP_MONTHLY_CHECKS`, `USAGE_CAP_DAILY_TOKENS`). They apply per household.

## Model access

Neo talks to models through the Anthropic SDK in one of two modes. Pick one per environment.

**Direct Anthropic** (default). Set `ANTHROPIC_API_KEY` and leave `NEO_MODEL_GATEWAY` unset. Only the Anthropic family is available, with the direct model ids (`claude-haiku-4-5`, `claude-sonnet-5`, `claude-opus-5`). This is how Phase 1 instances ran and nothing about it changes.

**Vercel AI Gateway**. Set `NEO_MODEL_GATEWAY=true` and `AI_GATEWAY_API_KEY` (create the key with a budget; see [deployment.md](deployment.md#ai-gateway)). The same SDK is pointed at `https://ai-gateway.vercel.sh` and model ids gain a creator prefix (`anthropic/claude-sonnet-5`). Every request carries a provider policy that the gateway enforces or refuses:

- **Zero data retention.** `zeroDataRetention: true` on every call. If no ZDR provider can serve the model, the request fails instead of falling back to one that retains data.
- **US inference.** `inferenceRegion: { scope: "zone", geoRegion: "us" }` on every call, again failing closed. The gateway charges a regional rate: Claude costs **+10%** over the global price. Set `NEO_GATEWAY_REGION=global` to drop the pin and the surcharge (ZDR stays on).
- **Provider order** per family (below). There is no `only` list, so the gateway can move to the next ZDR, US provider in the order if one is down.

Large-tier models (Opus 5, GPT-6 Astra, Grok 4.6, Kimi K3 at high effort) fall back to the family's medium model when the gateway cannot serve them; a new team's gateway account may rate-limit premium models per model ("No access to this model at this time") until Vercel support raises the limit, and the chip shows the model that actually answered.

With the gateway on, household members can choose a **model family** in Settings → Routing. `NEO_MODEL_FAMILIES` (comma list, default `anthropic`) is the allowlist; Anthropic is always included. `NEO_MODEL_SMALL`, `NEO_MODEL_MEDIUM` and `NEO_MODEL_LARGE` replace the Anthropic ladder models and accept either id form (`claude-opus-5-5` or `anthropic/claude-opus-5.5`). With the gateway off, a stored non-Anthropic choice silently uses the Anthropic ladder.

### Models

Prices are USD per million input / output tokens at the global rate.

| Family | small | medium | large | Provider order | US pin |
|---|---|---|---|---|---|
| **Anthropic** (default) | `anthropic/claude-haiku-4.5` $1 / $5 | `anthropic/claude-sonnet-5` $2 / $10 | `anthropic/claude-opus-5` $5 / $25 (`claude-opus-5.5` $4 / $20 via `NEO_MODEL_LARGE`) | `anthropic`, `bedrock`, `vertexAnthropic`, `claudeaws` | Yes |
| **OpenAI** | `openai/gpt-6-luna` $0.10 / $0.50 | `openai/gpt-6-sol` $2 / $10 | `openai/gpt-6-astra` $10 / $50 | `openai` | Yes |
| **Kimi** | Haiku 4.5 (Anthropic) | `moonshotai/kimi-k3` $3 / $15 | `moonshotai/kimi-k3` $3 / $15, effort high | `baseten`, `fireworks`, `bedrock` | Yes |
| **Grok** (experimental) | `spacexai/grok-4.1-fast-reasoning` $0.20 / $0.50 | `spacexai/grok-4.7` $1.20 / $3.60 | `spacexai/grok-4.6` $2 / $6, effort xhigh | `xai`, `vertex` | **No**: the gateway reports no region for Grok, so the pin is relaxed for `xai` and `vertex` |

Enable a non-Anthropic family only after the gateway spike (`apps/web/scripts/gateway-spike.ts`) and the prompt-injection eval (`apps/web/scripts/injection-eval.ts`, which runs Neo's real agent loop and tools against the fixtures in `apps/web/test/fixtures/injection/`) pass for it. The results for the curated catalog are in `_specs/model-routing.md`.

### What is routed and what is pinned

A **chat turn** is classified into a tier (small, medium, large). The member's preference then picks the rung and effort on their family's ladder:

| Tier | cost | balanced (default) | intelligence |
|---|---|---|---|
| small | small, low | small, low | medium, low |
| medium | medium, low | medium, medium | large, medium |
| large | medium, medium | large, medium | large, high |

Effort is clamped to the levels a model accepts. Everything else is pinned to Anthropic models in every family and preference:

| Function | Model |
|---|---|
| Chat turn | Routed: small / medium / large |
| Incident playbook turn | Large (Opus 5), effort high; the router is skipped |
| Resume after a confirmation | The turn's original route |
| Context compression and anchor summaries | Haiku 4.5 |
| Forwarded-email and SMS triage | Sonnet 5 (low, retried at medium) |

The router is chosen with `NEO_ROUTER`:

- `jev` (default with the gateway): TypeSafe AI's Jev evaluation model scores a redacted excerpt of the message for complexity, stakes and whether it needs a tool. The call requests ZDR (`NEO_ROUTER_ZDR=false` opts out). Jev has no ZDR endpoint on the gateway today, so with the default settings it fails closed and Neo uses the rules below until that changes. Any error or a 1.5 s timeout also falls back to rules.
- `rules` (default without the gateway and in `MOCK_MODE`): deterministic rules on length, links, contact details, incident keywords and attachments.
- `off`: every chat turn is medium.

The chat shows which model answered each turn.

## Environment variables

`.env.example` is the complete, commented list. For a production instance:

| Variable | Required | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes, unless the gateway is on | Direct Anthropic mode. Set a spend limit in the Anthropic console too. |
| `NEO_MODEL_GATEWAY`, `AI_GATEWAY_API_KEY` | No | Both set: every model call goes through Vercel AI Gateway. See [Model access](#model-access). |
| `NEO_GATEWAY_REGION`, `NEO_MODEL_FAMILIES` | No | Gateway only. Defaults `us`, `anthropic`. |
| `NEO_MODEL_SMALL`, `NEO_MODEL_MEDIUM`, `NEO_MODEL_LARGE` | No | Override the Anthropic ladder. Defaults: Haiku 4.5, Sonnet 5, Opus 5. |
| `NEO_ROUTER`, `NEO_ROUTER_ZDR` | No | Chat routing: `jev`, `rules` or `off`. Default `jev` with the gateway, `rules` without. |
| `NEO_AGENT_MODEL`, `NEO_COMPRESSION_MODEL`, `NEO_TRIAGE_MODEL` | No | Legacy overrides of the large rung, compression and triage. Defaults: `claude-opus-5`, `claude-haiku-4-5`, `claude-sonnet-5`. |
| `NEO_AGENT_EFFORT`, `NEO_ENABLE_FALLBACKS` | No | Defaults `medium`, `true` (on the gateway the refusal-fallback beta is sent only when `NEO_ENABLE_FALLBACKS=true` is set explicitly). |
| `DATABASE_URL` | Yes | The **`app_user`** role, not the owner. `?sslmode=require` on Neon. |
| `MIGRATION_DATABASE_URL` | For migrations | The owner role; used only by `pnpm db:migrate`. Never give it to the app. |
| `NEO_DB_DRIVER` | No | `neon` on Vercel + Neon (auto-detected). |
| `AUTH_SECRET` | Yes | Random 32 bytes. Rotating it signs everyone out. |
| `AUTH_URL` | No | Unset on Vercel. Set it behind other proxies. |
| `AUTH_TRUST_HOST` | Yes | `true` on Vercel. |
| `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` | One sign-in method required | Google sign-in. |
| `AUTH_RESEND_KEY`, `EMAIL_FROM` | One sign-in method required | Magic-link sign-in. The Resend marketplace integration sets `MESSAGING_RESEND_API_KEY` and `MESSAGING_RESEND_EMAIL_DOMAIN` instead, which are accepted as fallbacks. |
| `GOOGLE_SAFE_BROWSING_API_KEY` | Recommended | Skipped if unset. |
| `VIRUSTOTAL_API_KEY` | Recommended | Skipped if unset. 4 req/min on free tier. |
| `VIRUSTOTAL_SUBMIT` | No | Default `true`: unknown URLs are submitted to VirusTotal for scanning. `false` = lookups only. |
| `URLSCAN_API_KEY`, `URLSCAN_ENABLED` | Optional | Leave `URLSCAN_ENABLED=false` unless you accept that submitted URLs may be visible on urlscan.io. |
| `USAGE_CAP_MONTHLY_CHECKS`, `USAGE_CAP_DAILY_TOKENS` | No | Defaults 50 and 300000 per household. |
| `NEO_MASTER_KEY` | Yes (for uploads and forwarding) | 32 random bytes, base64. Encrypts evidence at rest. Never rotate it without re-encrypting. |
| `NEO_ARTIFACT_RETENTION_DAYS` | No | Default 30. Evidence files are deleted after this many days; verdicts are kept. |
| `BLOB_READ_WRITE_TOKEN` or `BLOB_STORE_ID` | Yes (for uploads and forwarding) | Set by connecting a Vercel Blob store (new stores use OIDC and set only `BLOB_STORE_ID`). |
| `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` | Yes (for forwarding) | Set by the Inngest integration. |
| `NEO_INBOUND_DOMAIN` | For forwarding | Domain of the household forwarding addresses, e.g. `inbound.example.com`. Required for the forwarding address. |
| `RESEND_WEBHOOK_SECRET` | For forwarding | Signing secret of the Resend `email.received` webhook. The webhook returns 503 while unset. |
| `RESEND_API_KEY` | No | Alias for `AUTH_RESEND_KEY`; used for fetching received mail and sending result emails. |
| `NEO_INBOUND_RATE_LIMIT_PER_HOUR` | No | Default 30 forwarded messages per address per hour. |
| `MOCK_MODE` | Yes | **`false`** in production. |
| `DEV_AUTH_BYPASS` | No | Leave unset/`false`. Refused in production and preview regardless. |
| `INJECTION_GUARD_MODE` | No | `monitor` (default) or `block`. |
| `LOG_LEVEL` | No | `info`. |

## Database roles and RLS

Neo scopes every query by `tenant_id` in code **and** enables Postgres row-level security as a second layer. RLS is **silently bypassed** for superusers, roles with `BYPASSRLS`, and (unless `FORCE ROW LEVEL SECURITY` is set) the table owner. Neon's default role owns the tables it creates, so do not run the app with it.

Create a dedicated role for the app, as the owner:

```sql
CREATE ROLE app_user LOGIN PASSWORD '<strong password>' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_user;
-- Security-definer functions from migration 0003 (forwarding lookup, retention jobs).
-- The migration grants these itself when app_user already exists; run them if you create the role afterwards.
GRANT EXECUTE ON FUNCTION public.resolve_inbound_address(text) TO app_user;
GRANT EXECUTE ON FUNCTION public.list_expired_artifacts(integer) TO app_user;
GRANT EXECUTE ON FUNCTION public.purge_old_inbound_messages(integer) TO app_user;
-- Migration 0007 (household invite lookup).
GRANT EXECUTE ON FUNCTION public.lookup_household_invite(text) TO app_user;
-- Migration 0008 (alert retention).
GRANT EXECUTE ON FUNCTION public.purge_old_alerts() TO app_user;
-- Migration 0009 (device enrollment lookup, offline sweep, device retention).
GRANT EXECUTE ON FUNCTION public.lookup_device_enrollment_code(text) TO app_user;
GRANT EXECUTE ON FUNCTION public.list_stale_devices(timestamptz) TO app_user;
GRANT EXECUTE ON FUNCTION public.purge_old_devices() TO app_user;
-- Migration 0010 (device signal and reputation cache retention).
GRANT EXECUTE ON FUNCTION public.purge_old_device_signals() TO app_user;
GRANT EXECUTE ON FUNCTION public.purge_expired_reputation_cache() TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON reputation_cache TO app_user;  -- tenant-less table
```

(`packages/db/sql/create-app-user.sql` is the same script with a verification query.) Run migrations as the owner. Run the app as `app_user`. You can confirm isolation with:

```sql
SET ROLE app_user;
SELECT count(*) FROM conversations;   -- expect 0 without app.tenant_id set
```

## Operating it

- **Updates:** pull from upstream into your fork, run migrations with the owner string, then let Vercel deploy.
- **Backups:** Neon keeps point-in-time history on its free plan for a limited window. Take your own `pg_dump` if the data matters.
- **Secrets:** use Vercel's Sensitive environment variables. Give Preview deployments different (or no) API keys.
- **Security issues** in Neo itself: see [SECURITY.md](../SECURITY.md).
