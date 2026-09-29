CREATE TABLE "device_expected_tools" (
	"tenant_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"tool_id" text NOT NULL,
	"peer_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_expected_tools_device_id_tool_id_pk" PRIMARY KEY("device_id","tool_id"),
	CONSTRAINT "device_expected_tools_peer_ids_cardinality_check" CHECK (coalesce(array_length("device_expected_tools"."peer_ids", 1), 0) <= 10)
);
--> statement-breakpoint
CREATE TABLE "device_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"client_event_id" uuid NOT NULL,
	"type" text NOT NULL,
	"detector" text NOT NULL,
	"subject" text NOT NULL,
	"payload" jsonb NOT NULL,
	"severity" text,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"escalated" boolean DEFAULT false NOT NULL,
	"verdict_id" uuid,
	"alert_id" uuid,
	"observed_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_signals_outcome_check" CHECK ("device_signals"."outcome" in ('pending', 'alerted', 'recorded', 'dismissed')),
	CONSTRAINT "device_signals_severity_check" CHECK ("device_signals"."severity" is null or "device_signals"."severity" in ('low', 'medium', 'high', 'critical')),
	CONSTRAINT "device_signals_subject_length_check" CHECK (char_length("device_signals"."subject") <= 253)
);
--> statement-breakpoint
CREATE TABLE "reputation_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "verdicts" DROP CONSTRAINT "verdicts_subject_type_check";--> statement-breakpoint
ALTER TABLE "verdicts" DROP CONSTRAINT "verdicts_source_check";--> statement-breakpoint
ALTER TABLE "alerts" DROP CONSTRAINT "alerts_kind_check";--> statement-breakpoint
ALTER TABLE "device_expected_tools" ADD CONSTRAINT "device_expected_tools_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_expected_tools" ADD CONSTRAINT "device_expected_tools_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_expected_tools" ADD CONSTRAINT "device_expected_tools_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_signals" ADD CONSTRAINT "device_signals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_signals" ADD CONSTRAINT "device_signals_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_signals" ADD CONSTRAINT "device_signals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_signals" ADD CONSTRAINT "device_signals_verdict_id_verdicts_id_fk" FOREIGN KEY ("verdict_id") REFERENCES "public"."verdicts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_signals" ADD CONSTRAINT "device_signals_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_expected_tools_tenant_idx" ON "device_expected_tools" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "device_signals_device_event_idx" ON "device_signals" USING btree ("device_id","client_event_id");--> statement-breakpoint
CREATE INDEX "device_signals_tenant_user_observed_idx" ON "device_signals" USING btree ("tenant_id","user_id","observed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "device_signals_tenant_device_received_idx" ON "device_signals" USING btree ("tenant_id","device_id","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "reputation_cache_expires_idx" ON "reputation_cache" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "verdicts" ADD CONSTRAINT "verdicts_subject_type_check" CHECK ("verdicts"."subject_type" in ('email', 'sms', 'url', 'page', 'signin_alert', 'file', 'conversation', 'software', 'remote_session', 'permission'));--> statement-breakpoint
ALTER TABLE "verdicts" ADD CONSTRAINT "verdicts_source_check" CHECK ("verdicts"."source" in ('chat', 'inbound', 'api', 'device'));--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_kind_check" CHECK ("alerts"."kind" in ('member_verdict', 'member_joined', 'member_left', 'device_enrolled', 'device_offline', 'device_removed', 'scam_page', 'dangerous_site', 'remote_access', 'unwanted_software', 'permission_grant', 'scam_in_progress'));--> statement-breakpoint
-- ── Row-level security (same policy as 0001_rls) ──
ALTER TABLE "device_signals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "device_signals"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "device_expected_tools" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "device_expected_tools"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
-- reputation_cache holds only public reputation facts about domains and hashes, never who
-- asked; it is intentionally tenant-less and carries no RLS (see packages/db/docs/rls.md).
-- ── Retention across tenants (security definer; see packages/db/docs/rls.md and 0003) ──
-- Device signal rows older than 30 days by received_at. Returns the number deleted.
CREATE FUNCTION "public"."purge_old_device_signals"()
RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH deleted AS (
    DELETE FROM public.device_signals s
    WHERE s.received_at < now() - interval '30 days'
    RETURNING 1
  )
  SELECT count(*)::integer FROM deleted
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."purge_old_device_signals"() FROM PUBLIC;--> statement-breakpoint
-- Expired reputation_cache rows. Returns the number deleted.
CREATE FUNCTION "public"."purge_expired_reputation_cache"()
RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH deleted AS (
    DELETE FROM public.reputation_cache c
    WHERE c.expires_at < now()
    RETURNING 1
  )
  SELECT count(*)::integer FROM deleted
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."purge_expired_reputation_cache"() FROM PUBLIC;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT EXECUTE ON FUNCTION "public"."purge_old_device_signals"() TO app_user;
    GRANT EXECUTE ON FUNCTION "public"."purge_expired_reputation_cache"() TO app_user;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "reputation_cache" TO app_user;
  END IF;
END
$$;