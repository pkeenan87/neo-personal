CREATE TABLE "known_signin_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"device_label" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "known_signin_devices_provider_check" CHECK ("known_signin_devices"."provider" in ('google', 'microsoft', 'apple', 'meta', 'amazon', 'paypal'))
);
--> statement-breakpoint
CREATE TABLE "signin_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"event" text NOT NULL,
	"device_label" text,
	"coarse_location" text,
	"event_time" timestamp with time zone,
	"source" text NOT NULL,
	"authenticated" boolean NOT NULL,
	"verdict_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signin_events_provider_check" CHECK ("signin_events"."provider" in ('google', 'microsoft', 'apple', 'meta', 'amazon', 'paypal')),
	CONSTRAINT "signin_events_event_check" CHECK ("signin_events"."event" in ('new_signin', 'new_device', 'password_changed', 'mfa_or_recovery_changed', 'suspicious_activity')),
	CONSTRAINT "signin_events_source_check" CHECK ("signin_events"."source" in ('forwarded', 'outlook'))
);
--> statement-breakpoint
ALTER TABLE "known_signin_devices" ADD CONSTRAINT "known_signin_devices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "known_signin_devices" ADD CONSTRAINT "known_signin_devices_membership_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."memberships"("tenant_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signin_events" ADD CONSTRAINT "signin_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signin_events" ADD CONSTRAINT "signin_events_verdict_id_verdicts_id_fk" FOREIGN KEY ("verdict_id") REFERENCES "public"."verdicts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signin_events" ADD CONSTRAINT "signin_events_membership_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."memberships"("tenant_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "known_signin_devices_pair_idx" ON "known_signin_devices" USING btree ("tenant_id","user_id","provider","device_label");--> statement-breakpoint
CREATE INDEX "signin_events_user_created_idx" ON "signin_events" USING btree ("tenant_id","user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "signin_events_verdict_idx" ON "signin_events" USING btree ("verdict_id");
--> statement-breakpoint
ALTER TABLE signin_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON signin_events
USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.signin_events TO app_user;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE known_signin_devices ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON known_signin_devices
USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.known_signin_devices TO app_user;
  END IF;
END $$;
