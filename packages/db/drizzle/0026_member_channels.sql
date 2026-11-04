CREATE TABLE "member_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"platform_id" text NOT NULL,
	"verified_at" timestamp with time zone,
	"verification_code_hash" text,
	"verification_expires_at" timestamp with time zone,
	"verification_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_channels_channel_check" CHECK ("member_channels"."channel" in ('sms'))
);
--> statement-breakpoint
ALTER TABLE "notification_outbox" DROP CONSTRAINT "notification_outbox_channel_check";--> statement-breakpoint
ALTER TABLE "member_channels" ADD CONSTRAINT "member_channels_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_channels" ADD CONSTRAINT "member_channels_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "member_channels_verified_idx" ON "member_channels" USING btree ("channel","platform_id") WHERE "member_channels"."verified_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "member_channels_member_idx" ON "member_channels" USING btree ("tenant_id","member_id","channel","platform_id");--> statement-breakpoint
CREATE INDEX "member_channels_tenant_member_idx" ON "member_channels" USING btree ("tenant_id","member_id");--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_channel_check" CHECK ("notification_outbox"."channel" in ('email', 'sms'));--> statement-breakpoint
ALTER TABLE member_channels ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON member_channels
USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.member_channels TO app_user;
  END IF;
END $$;
--> statement-breakpoint
-- Resolve a sender to a member before any tenant is known (the Twilio channel). Verified rows only; the
-- partial unique index guarantees at most one. Returns identifiers and the household role (memberships.role; "member" for
-- a member with no account), never the code hash.
CREATE FUNCTION public.lookup_member_channel(p_channel text, p_platform_id text)
RETURNS TABLE(tenant_id uuid, member_id uuid, user_id text, role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT c.tenant_id, c.member_id, m.user_id, COALESCE(ms.role, 'member')::text
  FROM public.member_channels c
  JOIN public.members m ON m.id = c.member_id AND m.tenant_id = c.tenant_id
  LEFT JOIN public.memberships ms ON ms.tenant_id = c.tenant_id AND ms.user_id = m.user_id
  WHERE c.channel = p_channel AND c.platform_id = p_platform_id AND c.verified_at IS NOT NULL
  LIMIT 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.lookup_member_channel(text, text) FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT EXECUTE ON FUNCTION public.lookup_member_channel(text, text) TO app_user;
  END IF;
END $$;
