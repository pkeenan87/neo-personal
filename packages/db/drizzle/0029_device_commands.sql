-- End a remote session from chat (_specs/v2-m3-cutover.md section 4): device_commands (the server-to-device command queue the
-- policy bundle carries) and the end_session incident action kind. The incident_actions CHECK is dropped and re-added as 0024 does.
-- Additive; no data is changed.

CREATE TABLE "device_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"alert_id" uuid,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"requires_confirmation" boolean NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"result" jsonb,
	CONSTRAINT "device_commands_kind_check" CHECK ("device_commands"."kind" in ('end_session')),
	CONSTRAINT "device_commands_status_check" CHECK ("device_commands"."status" in ('pending', 'delivered', 'confirmed', 'declined', 'done', 'failed', 'expired'))
);
--> statement-breakpoint
ALTER TABLE "incident_actions" DROP CONSTRAINT "incident_actions_kind_check";--> statement-breakpoint
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_commands_tenant_device_idx" ON "device_commands" USING btree ("tenant_id","device_id","status");--> statement-breakpoint
ALTER TABLE "incident_actions" ADD CONSTRAINT "incident_actions_kind_check" CHECK ("incident_actions"."kind" in ('mark_expected', 'allow_once', 'approve_request', 'deny_request', 'end_session'));--> statement-breakpoint
ALTER TABLE device_commands ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON device_commands
USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.device_commands TO app_user;
  END IF;
END $$;
--> statement-breakpoint
-- The 5-minute sweep expires commands nobody answered, across households (SECURITY DEFINER, like expire_child_requests).
-- list_expired_device_commands only reads (the shadow run); expire_device_commands marks them expired and returns them
-- so the caller can settle each incident. A device answering at the same moment wins or loses atomically on the status.
CREATE FUNCTION public.list_expired_device_commands(p_now timestamptz)
RETURNS TABLE(id uuid, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT c.id, c.tenant_id FROM public.device_commands c
  WHERE c.status IN ('pending', 'delivered') AND c.expires_at <= p_now
$$;
--> statement-breakpoint
CREATE FUNCTION public.expire_device_commands(p_now timestamptz)
RETURNS TABLE(id uuid, tenant_id uuid, alert_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  UPDATE public.device_commands c
  SET status = 'expired', completed_at = p_now, result = jsonb_build_object('outcome', 'expired', 'reason', 'no_response')
  WHERE c.status IN ('pending', 'delivered') AND c.expires_at <= p_now
  RETURNING c.id, c.tenant_id, c.alert_id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.list_expired_device_commands(timestamptz) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.expire_device_commands(timestamptz) FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT EXECUTE ON FUNCTION public.list_expired_device_commands(timestamptz) TO app_user;
    GRANT EXECUTE ON FUNCTION public.expire_device_commands(timestamptz) TO app_user;
  END IF;
END $$;
