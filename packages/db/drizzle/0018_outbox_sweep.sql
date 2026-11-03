-- Outbox sweep (_specs/v2-m1-elder.md §6). `notification_outbox` has tenant RLS, so the
-- cross-tenant sweep finds households with sendable rows through this security definer
-- function, then drains each one in its own tenant context. Returns tenant ids only.
CREATE FUNCTION "public"."list_outbox_tenants"(max_attempts integer, page_limit integer)
RETURNS TABLE(tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT DISTINCT o.tenant_id
  FROM public.notification_outbox o
  WHERE o.sent_at IS NULL
    AND o.attempts < $1
    AND (o.lease_until IS NULL OR o.lease_until < now())
  LIMIT $2
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."list_outbox_tenants"(integer, integer) FROM PUBLIC;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT EXECUTE ON FUNCTION "public"."list_outbox_tenants"(integer, integer) TO app_user;
  END IF;
END
$$;
