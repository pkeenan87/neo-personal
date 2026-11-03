CREATE TABLE "members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" text,
	"display_name" text NOT NULL,
	"role" text NOT NULL,
	"mode" text DEFAULT 'standard' NOT NULL,
	"birth_year" integer,
	"helper_member_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"contact_ciphertext" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "members_role_check" CHECK ("members"."role" in ('owner', 'adult', 'child', 'elder')),
	CONSTRAINT "members_mode_check" CHECK ("members"."mode" in ('standard', 'child', 'elder')),
	CONSTRAINT "members_display_name_length_check" CHECK (char_length("members"."display_name") between 1 and 80)
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"scope_id" uuid,
	"version" integer NOT NULL,
	"rules" jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policies_scope_check" CHECK ("policies"."scope" in ('household', 'member', 'device')),
	CONSTRAINT "policies_scope_id_check" CHECK (("policies"."scope" = 'household') = ("policies"."scope_id" is null)),
	CONSTRAINT "policies_version_check" CHECK ("policies"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "incident_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"alert_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"requested_by" text NOT NULL,
	"approved_by" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incident_actions_kind_check" CHECK ("incident_actions"."kind" in ('mark_expected', 'allow_once')),
	CONSTRAINT "incident_actions_requested_by_check" CHECK ("incident_actions"."requested_by" in ('agent', 'admin')),
	CONSTRAINT "incident_actions_status_check" CHECK ("incident_actions"."status" in ('pending', 'approved', 'rejected', 'done', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "notification_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"channel" text NOT NULL,
	"destination_ciphertext" text NOT NULL,
	"template" text NOT NULL,
	"payload" jsonb NOT NULL,
	"alert_id" uuid,
	"recipient_member_id" uuid,
	"recipient_user_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"provider_id" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_outbox_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "notification_outbox_channel_check" CHECK ("notification_outbox"."channel" in ('email'))
);
--> statement-breakpoint
ALTER TABLE "alerts" DROP CONSTRAINT "alerts_kind_check";--> statement-breakpoint
ALTER TABLE "device_enrollment_codes" ADD COLUMN "member_id" uuid;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "member_id" uuid;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "member_id" uuid;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "status" text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "signal_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "eve_session_id" text;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_actions" ADD CONSTRAINT "incident_actions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_actions" ADD CONSTRAINT "incident_actions_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "members_tenant_user_idx" ON "members" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "members_tenant_idx" ON "members" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "policies_scope_version_idx" ON "policies" USING btree ("tenant_id","scope",coalesce("scope_id", '00000000-0000-0000-0000-000000000000'::uuid),"version");--> statement-breakpoint
CREATE INDEX "incident_actions_tenant_alert_idx" ON "incident_actions" USING btree ("tenant_id","alert_id");--> statement-breakpoint
CREATE INDEX "notification_outbox_pending_idx" ON "notification_outbox" USING btree ("sent_at","lease_until") WHERE "notification_outbox"."sent_at" is null;--> statement-breakpoint
CREATE INDEX "notification_outbox_tenant_alert_idx" ON "notification_outbox" USING btree ("tenant_id","alert_id");--> statement-breakpoint
ALTER TABLE "device_enrollment_codes" ADD CONSTRAINT "device_enrollment_codes_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_enrollment_codes_member_idx" ON "device_enrollment_codes" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "devices_tenant_member_idx" ON "devices" USING btree ("tenant_id","member_id");--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_status_check" CHECK ("alerts"."status" in ('open', 'acknowledged', 'resolved', 'false_positive'));--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_kind_check" CHECK ("alerts"."kind" in ('member_verdict', 'member_joined', 'member_left', 'device_enrolled', 'device_offline', 'device_removed', 'scam_page', 'dangerous_site', 'remote_access', 'unwanted_software', 'permission_grant', 'scam_in_progress', 'breach_detected', 'install_during_session', 'payment_under_pressure', 'protection_disabled'));--> statement-breakpoint
-- ── Backfill (_specs/v2-m1-elder.md §2) ──
-- One member per membership. Name: users.name, else the email local part, else 'Member'.
INSERT INTO "members" ("tenant_id", "user_id", "display_name", "role", "mode", "created_at")
SELECT m."tenant_id", m."user_id",
  left(coalesce(nullif(btrim(u."name"), ''), nullif(split_part(u."email", '@', 1), ''), 'Member'), 80),
  CASE m."role" WHEN 'owner' THEN 'owner' ELSE 'adult' END,
  'standard',
  m."created_at"
FROM "memberships" m
JOIN "users" u ON u."id" = m."user_id";--> statement-breakpoint
UPDATE "devices" d SET "member_id" = mem."id"
FROM "members" mem
WHERE mem."tenant_id" = d."tenant_id" AND mem."user_id" = d."user_id";--> statement-breakpoint
UPDATE "device_enrollment_codes" c SET "member_id" = mem."id"
FROM "members" mem
WHERE mem."tenant_id" = c."tenant_id" AND mem."user_id" = c."user_id";--> statement-breakpoint
UPDATE "alerts" a SET "member_id" = mem."id"
FROM "members" mem
WHERE mem."tenant_id" = a."tenant_id" AND mem."user_id" = a."subject_user_id";--> statement-breakpoint
UPDATE "alerts" SET "status" = 'acknowledged' WHERE "acknowledged_at" IS NOT NULL;--> statement-breakpoint
-- ── Row-level security (same policy as 0001_rls) ──
ALTER TABLE "members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "members"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "policies"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "incident_actions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "incident_actions"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "notification_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notification_outbox"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
