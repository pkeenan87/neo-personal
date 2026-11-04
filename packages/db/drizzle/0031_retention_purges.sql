-- Deletes household records past their fixed retention periods, returning one row per kind.
-- Fixed periods (_specs/v2-followups.md slice C); consents and audit_events are never purged. The daily retention job calls it.
CREATE FUNCTION "public"."purge_old_household_records"(p_now timestamp with time zone)
RETURNS TABLE (kind text, n integer)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH gone_outbox AS (
    DELETE FROM public.notification_outbox
    WHERE (created_at < p_now - 30 * interval '1 day' AND (sent_at IS NOT NULL OR attempts >= 5))
       OR created_at < p_now - 90 * interval '1 day'
    RETURNING 1
  ),
  gone_invites AS (
    DELETE FROM public.household_invites
    WHERE coalesce(accepted_at, revoked_at, expires_at) < p_now - 30 * interval '1 day'
    RETURNING 1
  ),
  gone_device_commands AS (
    DELETE FROM public.device_commands
    WHERE expires_at < p_now - 30 * interval '1 day'
      AND (completed_at IS NULL OR completed_at < p_now - 30 * interval '1 day')
    RETURNING 1
  ),
  gone_eve_sessions AS (
    DELETE FROM public.eve_sessions
    WHERE created_at < p_now - 90 * interval '1 day'
    RETURNING 1
  ),
  gone_usage_events AS (
    DELETE FROM public.usage_events
    WHERE created_at < p_now - 400 * interval '1 day'
    RETURNING 1
  )
  SELECT 'outbox'::text, (SELECT count(*)::integer FROM gone_outbox)
  UNION ALL
  SELECT 'invites'::text, (SELECT count(*)::integer FROM gone_invites)
  UNION ALL
  SELECT 'device_commands'::text, (SELECT count(*)::integer FROM gone_device_commands)
  UNION ALL
  SELECT 'eve_sessions'::text, (SELECT count(*)::integer FROM gone_eve_sessions)
  UNION ALL
  SELECT 'usage_events'::text, (SELECT count(*)::integer FROM gone_usage_events)
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."purge_old_household_records"(timestamp with time zone) FROM PUBLIC;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT EXECUTE ON FUNCTION "public"."purge_old_household_records"(timestamp with time zone) TO app_user;
  END IF;
END
$$;
