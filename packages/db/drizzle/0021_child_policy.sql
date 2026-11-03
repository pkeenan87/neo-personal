-- Child policy (_specs/v2-m2-child.md sections 2, 3 and 8, slice 1b): the household's consent log,
-- the child request table (used from slice 3), and three alert kinds (self_harm_attempts,
-- app_approval, child_request), added by dropping and re-adding alerts_kind_check as 0017 does.
-- No data is changed.

CREATE TABLE "child_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"device_id" uuid,
	"kind" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reason" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"grant" jsonb,
	"alert_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "child_requests_kind_check" CHECK ("child_requests"."kind" in ('more_time', 'unblock_site', 'install_app')),
	CONSTRAINT "child_requests_status_check" CHECK ("child_requests"."status" in ('pending', 'approved', 'denied', 'expired')),
	CONSTRAINT "child_requests_reason_length_check" CHECK ("child_requests"."reason" is null or char_length("child_requests"."reason") <= 140)
);
--> statement-breakpoint
CREATE TABLE "consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"granted_by" text,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "consents_kind_check" CHECK ("consents"."kind" in ('monitoring_notice', 'guardian_consent', 'elder_self_consent'))
);
--> statement-breakpoint
ALTER TABLE "alerts" DROP CONSTRAINT "alerts_kind_check";--> statement-breakpoint
ALTER TABLE "child_requests" ADD CONSTRAINT "child_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "child_requests" ADD CONSTRAINT "child_requests_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "child_requests" ADD CONSTRAINT "child_requests_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "child_requests" ADD CONSTRAINT "child_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "child_requests" ADD CONSTRAINT "child_requests_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "child_requests_tenant_status_created_idx" ON "child_requests" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE INDEX "consents_tenant_member_idx" ON "consents" USING btree ("tenant_id","member_id","granted_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_kind_check" CHECK ("alerts"."kind" in ('member_verdict', 'member_joined', 'member_left', 'device_enrolled', 'device_offline', 'device_removed', 'scam_page', 'dangerous_site', 'remote_access', 'unwanted_software', 'permission_grant', 'scam_in_progress', 'breach_detected', 'install_during_session', 'payment_under_pressure', 'protection_disabled', 'self_harm_attempts', 'app_approval', 'child_request'));
--> statement-breakpoint
-- ── Row-level security (same policy as 0001_rls) ──
ALTER TABLE "consents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "consents"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "child_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "child_requests"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
