-- Devices, enrollment codes and scoped desktop tokens (_specs/device-enrollment.md).
-- Existing desktop_tokens rows backfill to scopes '{full}' with device_id null (the column
-- default), so tokens minted before this migration keep working unchanged.
CREATE TABLE "device_enrollment_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"redeemed_at" timestamp with time zone,
	"device_id" uuid,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "device_enrollment_codes_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"platform" text NOT NULL,
	"name" text NOT NULL,
	"client_version" text NOT NULL,
	"enrolled_by" text,
	"enrollment" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"offline_alerted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	CONSTRAINT "devices_kind_check" CHECK ("devices"."kind" in ('browser_extension', 'desktop_agent')),
	CONSTRAINT "devices_platform_check" CHECK ("devices"."platform" in ('chrome', 'edge', 'firefox', 'windows', 'macos', 'linux')),
	CONSTRAINT "devices_enrollment_check" CHECK ("devices"."enrollment" in ('code', 'self')),
	CONSTRAINT "devices_name_length_check" CHECK (char_length("devices"."name") between 1 and 64),
	CONSTRAINT "devices_client_version_length_check" CHECK (char_length("devices"."client_version") between 1 and 32)
);
--> statement-breakpoint
ALTER TABLE "alerts" DROP CONSTRAINT "alerts_kind_check";--> statement-breakpoint
ALTER TABLE "desktop_tokens" ADD COLUMN "scopes" text[] DEFAULT '{full}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "desktop_tokens" ADD COLUMN "device_id" uuid;--> statement-breakpoint
ALTER TABLE "desktop_auth_requests" ADD COLUMN "device_kind" text;--> statement-breakpoint
ALTER TABLE "desktop_auth_requests" ADD COLUMN "device_platform" text;--> statement-breakpoint
ALTER TABLE "desktop_auth_requests" ADD COLUMN "device_name" text;--> statement-breakpoint
ALTER TABLE "desktop_auth_requests" ADD COLUMN "device_client_version" text;--> statement-breakpoint
ALTER TABLE "device_enrollment_codes" ADD CONSTRAINT "device_enrollment_codes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_enrollment_codes" ADD CONSTRAINT "device_enrollment_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_enrollment_codes" ADD CONSTRAINT "device_enrollment_codes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_enrollment_codes" ADD CONSTRAINT "device_enrollment_codes_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_enrolled_by_users_id_fk" FOREIGN KEY ("enrolled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_enrollment_codes_tenant_idx" ON "device_enrollment_codes" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "devices_tenant_user_idx" ON "devices" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "devices_active_last_seen_idx" ON "devices" USING btree ("last_seen_at") WHERE "devices"."revoked_at" is null;--> statement-breakpoint
ALTER TABLE "desktop_tokens" ADD CONSTRAINT "desktop_tokens_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- alerts.device_id was reserved without an FK in 0008 and never written; clear any stray value.
UPDATE "alerts" SET "device_id" = NULL WHERE "device_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "desktop_tokens_device_idx" ON "desktop_tokens" USING btree ("device_id");--> statement-breakpoint
ALTER TABLE "desktop_tokens" ADD CONSTRAINT "desktop_tokens_scopes_check" CHECK (cardinality("desktop_tokens"."scopes") > 0 and "desktop_tokens"."scopes" <@ array['full', 'device', 'signals:write', 'url:check']::text[]);--> statement-breakpoint
ALTER TABLE "desktop_tokens" ADD CONSTRAINT "desktop_tokens_device_scope_check" CHECK (("desktop_tokens"."device_id" is null) = ('full' = any("desktop_tokens"."scopes")));--> statement-breakpoint
ALTER TABLE "desktop_auth_requests" ADD CONSTRAINT "desktop_auth_requests_device_check" CHECK (("desktop_auth_requests"."device_kind" is null and "desktop_auth_requests"."device_platform" is null and "desktop_auth_requests"."device_name" is null and "desktop_auth_requests"."device_client_version" is null)
        or ("desktop_auth_requests"."device_kind" in ('browser_extension', 'desktop_agent')
          and "desktop_auth_requests"."device_platform" in ('chrome', 'edge', 'firefox', 'windows', 'macos', 'linux')
          and char_length("desktop_auth_requests"."device_name") between 1 and 64
          and char_length("desktop_auth_requests"."device_client_version") between 1 and 32));--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_kind_check" CHECK ("alerts"."kind" in ('member_verdict', 'member_joined', 'member_left', 'device_enrolled', 'device_offline', 'device_removed'));--> statement-breakpoint
-- ── Row-level security (same policy as 0001_rls) ──
ALTER TABLE "devices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "devices"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "device_enrollment_codes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "device_enrollment_codes"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
-- ── Pre-tenant lookup (security definer; see packages/db/docs/rls.md and 0003) ──
-- Enrollment by code knows only the code. Returns ids of a pending (unredeemed,
-- unrevoked, unexpired) code; everything else is read under the tenant's RLS context.
CREATE FUNCTION "public"."lookup_device_enrollment_code"(code_hash text)
RETURNS TABLE(id uuid, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT c.id, c.tenant_id
  FROM public.device_enrollment_codes c
  WHERE c.code_hash = $1
    AND c.redeemed_at IS NULL
    AND c.revoked_at IS NULL
    AND c.expires_at > now()
  LIMIT 1
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."lookup_device_enrollment_code"(text) FROM PUBLIC;--> statement-breakpoint
-- ── Offline sweep across tenants (security definer) ──
-- Active devices never offline-alerted whose last heartbeat (or enrollment, if none)
-- is older than `before`. Ids only; the job reads each device under its tenant context.
CREATE FUNCTION "public"."list_stale_devices"(before timestamptz)
RETURNS TABLE(id uuid, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT d.id, d.tenant_id
  FROM public.devices d
  WHERE d.revoked_at IS NULL
    AND d.offline_alerted_at IS NULL
    AND coalesce(d.last_seen_at, d.created_at) < $1
  ORDER BY coalesce(d.last_seen_at, d.created_at)
  LIMIT 1000
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."list_stale_devices"(timestamptz) FROM PUBLIC;--> statement-breakpoint
-- ── Retention across tenants (security definer) ──
-- Devices revoked more than 90 days ago, and redeemed, revoked or expired enrollment
-- codes older than 30 days. Returns the number of rows deleted.
CREATE FUNCTION "public"."purge_old_devices"()
RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH codes AS (
    DELETE FROM public.device_enrollment_codes c
    WHERE coalesce(c.redeemed_at, c.revoked_at, c.expires_at) < now() - interval '30 days'
    RETURNING 1
  ), devs AS (
    DELETE FROM public.devices d
    WHERE d.revoked_at IS NOT NULL AND d.revoked_at < now() - interval '90 days'
    RETURNING 1
  )
  SELECT ((SELECT count(*) FROM codes) + (SELECT count(*) FROM devs))::integer
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."purge_old_devices"() FROM PUBLIC;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT EXECUTE ON FUNCTION "public"."lookup_device_enrollment_code"(text) TO app_user;
    GRANT EXECUTE ON FUNCTION "public"."list_stale_devices"(timestamptz) TO app_user;
    GRANT EXECUTE ON FUNCTION "public"."purge_old_devices"() TO app_user;
  END IF;
END
$$;
