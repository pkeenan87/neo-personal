-- Row-level security: defense in depth behind tenantScoped().
--
-- Every tenant-owned table is readable/writable only for rows whose tenant matches the
-- transaction-local setting `app.tenant_id`, which tenantScoped() sets with
--   SELECT set_config('app.tenant_id', $1, true)
-- at the start of each transaction.
--
-- NULLIF(..., '') guards against the empty string current_setting() returns once a
-- local setting has been reset at transaction end (''::uuid would raise). An unset or
-- empty setting therefore matches no rows.
--
-- RLS only applies to roles without BYPASSRLS that do not own the table. Superusers and
-- the Neon default owner (neondb_owner) bypass it: the app must connect as a dedicated
-- non-owner role. See packages/db/docs/rls.md and packages/db/sql/create-app-user.sql.

-- tenants: the tenant row itself, keyed on id.
ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tenants"
  USING ("id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- memberships: tenant isolation, plus a user may read their own memberships so the app can
-- resolve a signed-in user's tenant before it knows the tenant id (app.user_id is set by
-- findTenantForUser / createTenantForUser).
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "memberships"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "membership_self_read" ON "memberships" FOR SELECT
  USING ("user_id" = NULLIF(current_setting('app.user_id', true), ''));--> statement-breakpoint

ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "conversations"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "turns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "turns"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "verdicts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "verdicts"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "artifacts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "artifacts"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- audit_events: tenant isolation, plus inserts of tenant-less events (e.g. failed sign-in).
-- Tenant-less rows are write-only for the app role; read them as the owner/ops role.
ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "audit_events"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "untenanted_insert" ON "audit_events" FOR INSERT
  WITH CHECK ("tenant_id" IS NULL);--> statement-breakpoint

ALTER TABLE "usage_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "usage_events"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
