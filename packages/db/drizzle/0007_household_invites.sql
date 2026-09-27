-- Household invites (_specs/household-invites.md) and one household per user.
--
-- Abort with a clear message if any user already belongs to two households; the unique
-- index below would otherwise fail with a generic duplicate-key error.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "memberships" GROUP BY "user_id" HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'memberships: some users belong to more than one household; resolve before applying 0007 (see _specs/household-invites.md)';
  END IF;
END
$$;--> statement-breakpoint
CREATE TABLE "household_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"email" text,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"send_count" integer DEFAULT 0 NOT NULL,
	"invited_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_by" text,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "household_invites_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "household_invites_kind_check" CHECK ("household_invites"."kind" in ('email', 'link')),
	CONSTRAINT "household_invites_email_check" CHECK (("household_invites"."kind" = 'email') = ("household_invites"."email" is not null))
);
--> statement-breakpoint
DROP INDEX "memberships_user_idx";--> statement-breakpoint
ALTER TABLE "household_invites" ADD CONSTRAINT "household_invites_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_invites" ADD CONSTRAINT "household_invites_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_invites" ADD CONSTRAINT "household_invites_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "household_invites_tenant_idx" ON "household_invites" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_one_household" ON "memberships" USING btree ("user_id");--> statement-breakpoint
-- ── Row-level security (same policy as 0001_rls) ──
ALTER TABLE "household_invites" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "household_invites"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
-- ── Pre-tenant lookup (security definer; see packages/db/docs/rls.md and 0003) ──
-- The invite page and accept route know only the secret. Returns ids of a pending,
-- unexpired, unrevoked invite; everything else is read under the tenant's RLS context.
CREATE FUNCTION "public"."lookup_household_invite"(token_hash text)
RETURNS TABLE(id uuid, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT i.id, i.tenant_id
  FROM public.household_invites i
  WHERE i.token_hash = $1
    AND i.accepted_at IS NULL
    AND i.revoked_at IS NULL
    AND i.expires_at > now()
  LIMIT 1
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."lookup_household_invite"(text) FROM PUBLIC;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT EXECUTE ON FUNCTION "public"."lookup_household_invite"(text) TO app_user;
  END IF;
END
$$;
