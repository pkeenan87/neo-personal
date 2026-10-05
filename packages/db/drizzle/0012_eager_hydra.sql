CREATE TABLE "digest_deliveries" (
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"iso_week" text NOT NULL,
	"state" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"run_id" text,
	"provider_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "digest_deliveries_state_check" CHECK ("digest_deliveries"."state" in ('sending', 'sent', 'empty', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "weekly_digest_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "digest_deliveries" ADD CONSTRAINT "digest_deliveries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_deliveries" ADD CONSTRAINT "digest_deliveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "digest_deliveries_user_week_idx" ON "digest_deliveries" USING btree ("user_id","iso_week");--> statement-breakpoint
-- Role defaults apply to both existing memberships and every creation/role transition.
UPDATE memberships SET weekly_digest_enabled = (role = 'owner');
--> statement-breakpoint
CREATE FUNCTION public.reset_weekly_digest_preference() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.role IS DISTINCT FROM OLD.role THEN
    NEW.weekly_digest_enabled := (NEW.role = 'owner');
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER memberships_digest_role_default BEFORE INSERT OR UPDATE OF role ON memberships
FOR EACH ROW EXECUTE FUNCTION public.reset_weekly_digest_preference();
--> statement-breakpoint
ALTER TABLE digest_deliveries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON digest_deliveries
USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.digest_deliveries TO app_user;
  END IF;
END $$;
--> statement-breakpoint
-- The ONLY global digest read: identifiers of eligible recipients, never content or addresses.
CREATE FUNCTION public.list_digest_recipients(cursor_tenant_id uuid, cursor_user_id text, page_limit integer)
RETURNS TABLE(tenant_id uuid, user_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT m.tenant_id, m.user_id FROM public.memberships m JOIN public.users u ON u.id = m.user_id
  WHERE m.weekly_digest_enabled AND u.email_verified IS NOT NULL AND u.email IS NOT NULL AND u.email <> ''
    AND ($1 IS NULL OR (m.tenant_id, m.user_id) > ($1, $2))
  ORDER BY m.tenant_id, m.user_id LIMIT LEAST(GREATEST(COALESCE($3, 1000), 1), 1000)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.list_digest_recipients(uuid, text, integer) FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT EXECUTE ON FUNCTION public.list_digest_recipients(uuid, text, integer) TO app_user;
  END IF;
END $$;
