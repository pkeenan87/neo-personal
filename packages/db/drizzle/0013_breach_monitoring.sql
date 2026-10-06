CREATE TABLE "breach_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"monitored_address_id" uuid NOT NULL,
	"breach_name" text NOT NULL,
	"breach_domain" text,
	"breach_date" date,
	"added_date" timestamp with time zone,
	"data_classes" text[] DEFAULT '{}'::text[] NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "monitored_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"digest" text NOT NULL,
	"encrypted_address" "bytea" NOT NULL,
	"verification_source" text NOT NULL,
	"verified_at" timestamp with time zone,
	"verification_token_hash" text,
	"verification_expires_at" timestamp with time zone,
	"verification_send_times" timestamp with time zone[] DEFAULT '{}'::timestamptz[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_successful_check_at" timestamp with time zone,
	"check_status" text DEFAULT 'never_checked' NOT NULL,
	CONSTRAINT "monitored_addresses_source_check" CHECK ("monitored_addresses"."verification_source" in ('sign_in', 'extra')),
	CONSTRAINT "monitored_addresses_status_check" CHECK ("monitored_addresses"."check_status" in ('never_checked', 'clean', 'breached', 'failed')),
	CONSTRAINT "monitored_addresses_send_times_check" CHECK (cardinality("monitored_addresses"."verification_send_times") <= 3),
	CONSTRAINT "monitored_addresses_verification_fields_check" CHECK (("monitored_addresses"."verified_at" IS NOT NULL AND "monitored_addresses"."verification_token_hash" IS NULL AND "monitored_addresses"."verification_expires_at" IS NULL) OR ("monitored_addresses"."verified_at" IS NULL AND (("monitored_addresses"."verification_token_hash" IS NULL AND "monitored_addresses"."verification_expires_at" IS NULL) OR ("monitored_addresses"."verification_token_hash" IS NOT NULL AND "monitored_addresses"."verification_expires_at" IS NOT NULL)))),
	CONSTRAINT "monitored_addresses_sign_in_verified_check" CHECK ("monitored_addresses"."verification_source" <> 'sign_in' OR "monitored_addresses"."verified_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "alerts" DROP CONSTRAINT "alerts_kind_check";--> statement-breakpoint
ALTER TABLE "breach_observations" ADD CONSTRAINT "breach_observations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "monitored_addresses_tenant_id_idx" ON "monitored_addresses" USING btree ("tenant_id","id");--> statement-breakpoint
ALTER TABLE "breach_observations" ADD CONSTRAINT "breach_observations_address_fk" FOREIGN KEY ("tenant_id","monitored_address_id") REFERENCES "public"."monitored_addresses"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitored_addresses" ADD CONSTRAINT "monitored_addresses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitored_addresses" ADD CONSTRAINT "monitored_addresses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitored_addresses" ADD CONSTRAINT "monitored_addresses_membership_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."memberships"("tenant_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "breach_observations_address_name_idx" ON "breach_observations" USING btree ("tenant_id","monitored_address_id","breach_name");--> statement-breakpoint
CREATE INDEX "breach_observations_address_seen_idx" ON "breach_observations" USING btree ("tenant_id","monitored_address_id","first_seen_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "monitored_addresses_user_digest_idx" ON "monitored_addresses" USING btree ("tenant_id","user_id","digest");--> statement-breakpoint
CREATE UNIQUE INDEX "monitored_addresses_token_hash_idx" ON "monitored_addresses" USING btree ("verification_token_hash") WHERE "monitored_addresses"."verification_token_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "monitored_addresses_user_idx" ON "monitored_addresses" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "monitored_addresses_expiry_idx" ON "monitored_addresses" USING btree ("verification_expires_at");--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_kind_check" CHECK ("alerts"."kind" in ('member_verdict', 'member_joined', 'member_left', 'device_enrolled', 'device_offline', 'device_removed', 'scam_page', 'dangerous_site', 'remote_access', 'unwanted_software', 'permission_grant', 'scam_in_progress', 'breach_detected'));
--> statement-breakpoint
ALTER TABLE monitored_addresses ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON monitored_addresses
USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE breach_observations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON breach_observations
USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.monitored_addresses TO app_user;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.breach_observations TO app_user;
  END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.list_monitored_breach_addresses(cursor_tenant_id uuid, cursor_user_id text, cursor_address_id uuid, page_limit integer)
RETURNS TABLE(tenant_id uuid, user_id text, address_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT a.tenant_id, a.user_id, a.id
  FROM public.monitored_addresses a
  WHERE a.verified_at IS NOT NULL
    AND ($1 IS NULL OR (a.tenant_id, a.user_id, a.id) > ($1, $2, $3))
  ORDER BY a.tenant_id, a.user_id, a.id
  LIMIT LEAST(GREATEST(COALESCE($4, 1000), 1), 1000)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.list_monitored_breach_addresses(uuid, text, uuid, integer) FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT EXECUTE ON FUNCTION public.list_monitored_breach_addresses(uuid, text, uuid, integer) TO app_user;
  END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.purge_expired_breach_verification_tokens()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  purge_time timestamptz := clock_timestamp();
  cleared integer;
BEGIN
  WITH expired AS (
    SELECT id
    FROM public.monitored_addresses
    WHERE verified_at IS NULL AND verification_token_hash IS NOT NULL AND verification_expires_at <= purge_time
    ORDER BY verification_expires_at, id
    LIMIT 1000
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.monitored_addresses AS address
  SET verification_token_hash = NULL, verification_expires_at = NULL, updated_at = purge_time
  FROM expired
  WHERE address.id = expired.id;
  GET DIAGNOSTICS cleared = ROW_COUNT;
  RETURN cleared;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.purge_expired_breach_verification_tokens() FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT EXECUTE ON FUNCTION public.purge_expired_breach_verification_tokens() TO app_user;
  END IF;
END $$;
