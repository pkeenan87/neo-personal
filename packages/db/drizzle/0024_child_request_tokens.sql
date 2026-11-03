-- Child requests, slice 3 (_specs/v2-m2-child.md section 8): the hashed email-link decision token on
-- child_requests, two new incident_actions kinds (approve_request, deny_request; the CHECK is dropped and
-- re-added as 0017 does), and expire_child_requests(), the daily sweep that runs across households
-- (security definer, like purge_old_alerts). Additive; no data is changed.

ALTER TABLE "incident_actions" DROP CONSTRAINT "incident_actions_kind_check";--> statement-breakpoint
ALTER TABLE "child_requests" ADD COLUMN "decision_token_hash" text;--> statement-breakpoint
ALTER TABLE "child_requests" ADD COLUMN "decision_token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "child_requests" ADD COLUMN "origin" text DEFAULT 'device' NOT NULL;--> statement-breakpoint
ALTER TABLE "child_requests" ADD CONSTRAINT "child_requests_origin_check" CHECK ("child_requests"."origin" in ('device', 'engine'));--> statement-breakpoint
ALTER TABLE "incident_actions" ADD CONSTRAINT "incident_actions_kind_check" CHECK ("incident_actions"."kind" in ('mark_expected', 'allow_once', 'approve_request', 'deny_request'));
--> statement-breakpoint
-- A pending request past its expires_at is marked expired and its alert is resolved (the owner is not
-- asked about it any more). Returns how many requests were expired. EXECUTE is for app_user only.
CREATE FUNCTION "public"."expire_child_requests"(p_now timestamp with time zone)
RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH expired AS (
    UPDATE public.child_requests r
    SET status = 'expired', decision_token_hash = NULL, decision_token_expires_at = NULL, updated_at = p_now
    WHERE r.status = 'pending' AND r.expires_at IS NOT NULL AND r.expires_at <= p_now
    RETURNING r.alert_id
  ), closed AS (
    UPDATE public.alerts a
    SET status = 'resolved', resolved_at = p_now,
        acknowledged_at = COALESCE(a.acknowledged_at, p_now)
    WHERE a.id IN (SELECT alert_id FROM expired WHERE alert_id IS NOT NULL) AND a.status IN ('open', 'acknowledged')
    RETURNING 1
  )
  SELECT count(*)::integer FROM expired
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."expire_child_requests"(timestamp with time zone) FROM PUBLIC;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT EXECUTE ON FUNCTION "public"."expire_child_requests"(timestamp with time zone) TO app_user;
  END IF;
END
$$;
