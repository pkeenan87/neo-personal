-- Owner alerts (_specs/owner-alerts.md) and the owner's alert email threshold.
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_user_id" text,
	"device_id" uuid,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"verdict_id" uuid,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" text,
	"email_status" text DEFAULT 'pending' NOT NULL,
	"emailed_at" timestamp with time zone,
	CONSTRAINT "alerts_kind_check" CHECK ("alerts"."kind" in ('member_verdict', 'member_joined', 'member_left')),
	CONSTRAINT "alerts_severity_check" CHECK ("alerts"."severity" in ('low', 'medium', 'high', 'critical')),
	CONSTRAINT "alerts_email_status_check" CHECK ("alerts"."email_status" in ('pending', 'sent', 'skipped', 'failed')),
	CONSTRAINT "alerts_title_length_check" CHECK (char_length("alerts"."title") <= 140),
	CONSTRAINT "alerts_body_length_check" CHECK (char_length("alerts"."body") <= 1000)
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "alert_email_threshold" text DEFAULT 'high' NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_verdict_id_verdicts_id_fk" FOREIGN KEY ("verdict_id") REFERENCES "public"."verdicts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_tenant_dedupe_idx" ON "alerts" USING btree ("tenant_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "alerts_tenant_created_idx" ON "alerts" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_alert_email_threshold_check" CHECK ("memberships"."alert_email_threshold" in ('medium', 'high', 'critical', 'off'));--> statement-breakpoint
-- ── Row-level security (same policy as 0001_rls) ──
ALTER TABLE "alerts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "alerts"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
-- ── Retention across tenants (security definer; see packages/db/docs/rls.md and 0003) ──
-- Acknowledged alerts go after 90 days, unacknowledged ones after 180. Returns the count.
CREATE FUNCTION "public"."purge_old_alerts"()
RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH deleted AS (
    DELETE FROM public.alerts a
    WHERE (a.acknowledged_at IS NOT NULL AND a.created_at < now() - interval '90 days')
       OR a.created_at < now() - interval '180 days'
    RETURNING 1
  )
  SELECT count(*)::integer FROM deleted
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."purge_old_alerts"() FROM PUBLIC;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT EXECUTE ON FUNCTION "public"."purge_old_alerts"() TO app_user;
  END IF;
END
$$;
