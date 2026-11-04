CREATE TABLE "household_memory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_member_id" uuid,
	"text" text NOT NULL,
	"created_by" text,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "household_memory_source_check" CHECK ("household_memory"."source" in ('console', 'chat')),
	CONSTRAINT "household_memory_text_length_check" CHECK (char_length("household_memory"."text") between 1 and 280)
);
--> statement-breakpoint
ALTER TABLE "household_memory" ADD CONSTRAINT "household_memory_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_memory" ADD CONSTRAINT "household_memory_subject_member_id_members_id_fk" FOREIGN KEY ("subject_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_memory" ADD CONSTRAINT "household_memory_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "household_memory_tenant_created_idx" ON "household_memory" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "household_memory_expires_idx" ON "household_memory" USING btree ("expires_at");--> statement-breakpoint
-- ── Row-level security (same policy as 0001_rls) ──
ALTER TABLE "household_memory" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "household_memory"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
-- The daily retention sweep runs across households (security definer, like purge_old_alerts): it deletes
-- the entries past expires_at and returns how many. EXECUTE is for app_user only.
CREATE FUNCTION "public"."purge_expired_household_memory"(p_now timestamp with time zone)
RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH gone AS (
    DELETE FROM public.household_memory m WHERE m.expires_at <= p_now RETURNING 1
  )
  SELECT count(*)::integer FROM gone
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."purge_expired_household_memory"(timestamp with time zone) FROM PUBLIC;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."household_memory" TO app_user;
    GRANT EXECUTE ON FUNCTION "public"."purge_expired_household_memory"(timestamp with time zone) TO app_user;
  END IF;
END
$$;