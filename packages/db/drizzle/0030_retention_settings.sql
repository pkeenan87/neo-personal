ALTER TABLE "tenants" ADD COLUMN "retention_signals_days" integer;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "retention_incidents_days" integer;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "retention_child_requests_days" integer;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "retention_memory_days" integer;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_retention_signals_check" CHECK ("tenants"."retention_signals_days" is null or ("tenants"."retention_signals_days" >= 7 and "tenants"."retention_signals_days" <= 365));--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_retention_incidents_check" CHECK ("tenants"."retention_incidents_days" is null or ("tenants"."retention_incidents_days" >= 30 and "tenants"."retention_incidents_days" <= 1095));--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_retention_child_requests_check" CHECK ("tenants"."retention_child_requests_days" is null or ("tenants"."retention_child_requests_days" >= 7 and "tenants"."retention_child_requests_days" <= 365));--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_retention_memory_check" CHECK ("tenants"."retention_memory_days" is null or ("tenants"."retention_memory_days" >= 30 and "tenants"."retention_memory_days" <= 1095));
--> statement-breakpoint
-- ── Per-household retention (_specs/v2-m4-hardening.md section 1) ──
-- The cross-household purges join tenants and use each household's setting; a null setting is the default.
-- Defaults reproduce the earlier global rules: signals 30 days, alerts 180 days (acknowledged 90), memory 365 days.
-- Signatures are unchanged, so CREATE OR REPLACE keeps the app_user grants.
CREATE OR REPLACE FUNCTION "public"."purge_old_device_signals"()
RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH deleted AS (
    DELETE FROM public.device_signals s
    USING public.tenants t
    WHERE t.id = s.tenant_id
      AND s.received_at < now() - COALESCE(t.retention_signals_days, 30) * interval '1 day'
    RETURNING 1
  )
  SELECT count(*)::integer FROM deleted
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."purge_old_alerts"()
RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH deleted AS (
    DELETE FROM public.alerts a
    USING public.tenants t
    WHERE t.id = a.tenant_id
      AND ((a.acknowledged_at IS NOT NULL AND a.created_at < now() - LEAST(90, COALESCE(t.retention_incidents_days, 180)) * interval '1 day')
        OR a.created_at < now() - COALESCE(t.retention_incidents_days, 180) * interval '1 day')
    RETURNING 1
  )
  SELECT count(*)::integer FROM deleted
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."purge_expired_household_memory"(p_now timestamp with time zone)
RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH gone AS (
    DELETE FROM public.household_memory m
    USING public.tenants t
    WHERE t.id = m.tenant_id
      AND (m.expires_at <= p_now OR m.created_at < p_now - COALESCE(t.retention_memory_days, 365) * interval '1 day')
    RETURNING 1
  )
  SELECT count(*)::integer FROM gone
$$;--> statement-breakpoint
-- Decided or expired child requests are deleted once they are older than the household's setting (default 90 days)
-- by updated_at. Pending requests stay (expire_child_requests closes them first).
CREATE FUNCTION "public"."purge_old_child_requests"(p_now timestamp with time zone)
RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH gone AS (
    DELETE FROM public.child_requests r
    USING public.tenants t
    WHERE t.id = r.tenant_id AND r.status <> 'pending'
      AND r.updated_at < p_now - COALESCE(t.retention_child_requests_days, 90) * interval '1 day'
    RETURNING 1
  )
  SELECT count(*)::integer FROM gone
$$;--> statement-breakpoint
-- Read-only: how many rows each household-data purge would delete now, honouring each household's setting.
-- The shadow retention run records this and never deletes.
CREATE FUNCTION "public"."retention_preview"(p_now timestamp with time zone)
RETURNS TABLE (kind text, n integer)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT 'signals'::text, (SELECT count(*)::integer FROM public.device_signals s JOIN public.tenants t ON t.id = s.tenant_id
    WHERE s.received_at < p_now - COALESCE(t.retention_signals_days, 30) * interval '1 day')
  UNION ALL
  SELECT 'alerts'::text, (SELECT count(*)::integer FROM public.alerts a JOIN public.tenants t ON t.id = a.tenant_id
    WHERE (a.acknowledged_at IS NOT NULL AND a.created_at < p_now - LEAST(90, COALESCE(t.retention_incidents_days, 180)) * interval '1 day')
       OR a.created_at < p_now - COALESCE(t.retention_incidents_days, 180) * interval '1 day')
  UNION ALL
  SELECT 'child_requests'::text, (SELECT count(*)::integer FROM public.child_requests r JOIN public.tenants t ON t.id = r.tenant_id
    WHERE r.status <> 'pending' AND r.updated_at < p_now - COALESCE(t.retention_child_requests_days, 90) * interval '1 day')
  UNION ALL
  SELECT 'household_memory'::text, (SELECT count(*)::integer FROM public.household_memory m JOIN public.tenants t ON t.id = m.tenant_id
    WHERE m.expires_at <= p_now OR m.created_at < p_now - COALESCE(t.retention_memory_days, 365) * interval '1 day')
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."purge_old_child_requests"(timestamp with time zone) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."retention_preview"(timestamp with time zone) FROM PUBLIC;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT EXECUTE ON FUNCTION "public"."purge_old_child_requests"(timestamp with time zone) TO app_user;
    GRANT EXECUTE ON FUNCTION "public"."retention_preview"(timestamp with time zone) TO app_user;
  END IF;
END
$$;
