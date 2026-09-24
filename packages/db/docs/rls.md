# Row-level security in @neo/db

Tenant isolation has two layers:

1. **Application**: every query goes through `tenantScoped(db, tenantId)`, whose helpers
   always add `tenant_id = :tenantId`.
2. **Database (defense in depth)**: migration `drizzle/0001_rls.sql` enables RLS on every
   tenant-owned table (`tenants`, `memberships`, `conversations`, `turns`, `verdicts`,
   `artifacts`, `audit_events`, `usage_events`) with the policy

   ```sql
   USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
   ```

   (`tenants` keys on `id`). `tenantScoped()` runs every call in a transaction that first
   executes `SELECT set_config('app.tenant_id', $1, true)`. The setting is transaction-local,
   so it is safe behind PgBouncer / the Neon `-pooler` endpoint in transaction mode.
   `NULLIF(..., '')` makes an unset setting match nothing instead of raising on `''::uuid`.

Extra policies:

- `memberships.membership_self_read` (SELECT): rows where `user_id = app.user_id`, so
  `findTenantForUser()` can resolve a signed-in user's household before the tenant is known.
- `audit_events.untenanted_insert` (INSERT): events with `tenant_id IS NULL` (for example a
  failed sign-in). The app role can write but not read them.

Auth.js tables (`users`, `accounts`, `sessions`, `verification_tokens`, `authenticators`)
are user-owned and have no RLS.

## RLS only bites for a non-owner, non-BYPASSRLS role

Postgres skips RLS for superusers, roles with `BYPASSRLS`, and the table owner. The Neon
default role (`neondb_owner`) owns the tables and bypasses RLS, so **if the app connects as
the owner, the policies do nothing** and only layer 1 protects tenants.

Use two roles:

| Variable | Role | Used by |
|---|---|---|
| `MIGRATION_DATABASE_URL` | owner (`neondb_owner`) | `pnpm db:migrate`, `drizzle-kit` |
| `DATABASE_URL` | `app_user` (no BYPASSRLS, not owner) | the app (`createDb()`) |

Setup, after the first `pnpm db:migrate`, as the owner:

```sql
CREATE ROLE app_user WITH LOGIN PASSWORD 'change-me' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT CONNECT ON DATABASE neondb TO app_user;
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_user;
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'app_user'; -- both false
```

The same script lives in `sql/create-app-user.sql`. Create the role in SQL rather than the
Neon console (console-created roles join `neon_superuser` and can carry `BYPASSRLS`). Neon
branches inherit roles from their parent, so preview branches get `app_user` automatically
once it exists on the main branch.

`test/rls.test.ts` exercises exactly this: it creates `app_user` in PGlite, `SET ROLE`s to it,
and checks that an unfiltered query inside tenant B's scope cannot see tenant A's rows.

## Rules for new tables

- Tenant-owned table: add a non-null `tenant_id uuid` referencing `tenants(id)`, then add
  `ENABLE ROW LEVEL SECURITY` + a `tenant_isolation` policy in a custom migration
  (`pnpm --filter @neo/db exec drizzle-kit generate --custom --name=<name>`), and extend the
  table list in `test/rls.test.ts`.
- Queries that must run before a tenant is known (sign-in) set `app.user_id` instead and need
  an explicit, narrow policy like `membership_self_read`.
