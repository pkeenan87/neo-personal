-- Create the least-privilege role the Neo app connects as, so RLS applies to it.
--
-- Run once per database (and per Neon branch you create from a parent that lacks it), as the
-- owner role that runs migrations (Neon: neondb_owner), AFTER `pnpm db:migrate`.
-- Replace the password; never commit a real one. Then point DATABASE_URL at app_user
-- (use the pooled -pooler host on Neon) and keep MIGRATION_DATABASE_URL on the owner.
--
-- Create this role with SQL, not the Neon console: console/API-created roles join
-- neon_superuser and can carry BYPASSRLS, which silently disables every policy. Always run
-- the verification query at the end.

CREATE ROLE app_user WITH LOGIN PASSWORD 'change-me' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

GRANT CONNECT ON DATABASE neondb TO app_user;            -- adjust the database name
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;

-- Tables created by future migrations (run by the owner) are granted automatically.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_user;

-- Security-definer lookups that run before a tenant is known (migration 0003_phase1).
-- EXECUTE is revoked from PUBLIC, so grant it explicitly. Re-run these lines if you
-- create app_user after adding a new security-definer function (see docs/rls.md).
GRANT EXECUTE ON FUNCTION public.resolve_inbound_address(text) TO app_user;
GRANT EXECUTE ON FUNCTION public.list_expired_artifacts(integer) TO app_user;
GRANT EXECUTE ON FUNCTION public.purge_old_inbound_messages(integer) TO app_user;
GRANT EXECUTE ON FUNCTION public.lookup_household_invite(text) TO app_user;  -- 0007
GRANT EXECUTE ON FUNCTION public.purge_old_alerts() TO app_user;  -- 0008
GRANT EXECUTE ON FUNCTION public.lookup_device_enrollment_code(text) TO app_user;  -- 0009
GRANT EXECUTE ON FUNCTION public.list_stale_devices(timestamptz) TO app_user;  -- 0009
GRANT EXECUTE ON FUNCTION public.purge_old_devices() TO app_user;  -- 0009
GRANT EXECUTE ON FUNCTION public.purge_old_device_signals() TO app_user;  -- 0010
GRANT EXECUTE ON FUNCTION public.purge_expired_reputation_cache() TO app_user;  -- 0010
GRANT EXECUTE ON FUNCTION public.lookup_device_tenant(uuid) TO app_user;  -- 0011
GRANT EXECUTE ON FUNCTION public.list_digest_recipients(uuid, text, integer) TO app_user;  -- 0012
GRANT EXECUTE ON FUNCTION public.purge_weekly_digest_payloads(timestamptz) TO app_user;  -- 0012
GRANT EXECUTE ON FUNCTION public.list_monitored_breach_addresses(uuid, text, uuid, integer) TO app_user;  -- 0013
GRANT EXECUTE ON FUNCTION public.purge_expired_breach_verification_tokens() TO app_user;  -- 0013
GRANT EXECUTE ON FUNCTION public.list_outlook_connectors(uuid, text, integer) TO app_user;  -- 0016

-- reputation_cache is tenant-less (public reputation facts only); ALL TABLES above already
-- covers it once created, but grant explicitly in case app_user predates the 0010 migration.
GRANT SELECT, INSERT, UPDATE, DELETE ON reputation_cache TO app_user;  -- 0010

-- Verify: both columns must be false.
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'app_user';
