CREATE TABLE "inbound_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"local_part" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "inbound_addresses_local_part_unique" UNIQUE("local_part")
);
--> statement-breakpoint
CREATE TABLE "inbound_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"address_id" uuid NOT NULL,
	"provider_message_id" text NOT NULL,
	"from_address_hash" text NOT NULL,
	"forwarder_user_id" text,
	"artifact_id" uuid,
	"verdict_id" uuid,
	"status" text NOT NULL,
	"error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "inbound_messages_provider_message_id_unique" UNIQUE("provider_message_id"),
	CONSTRAINT "inbound_messages_status_check" CHECK ("inbound_messages"."status" in ('received', 'analyzing', 'done', 'rejected', 'over_cap', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "verdicts" ADD COLUMN "artifact_id" uuid;--> statement-breakpoint
ALTER TABLE "verdicts" ADD COLUMN "source" text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "filename" text;--> statement-breakpoint
-- Existing rows predate mime types: backfill through a temporary default, then drop it so
-- new rows must name their type.
ALTER TABLE "artifacts" ADD COLUMN "mime_type" text DEFAULT 'application/octet-stream' NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ALTER COLUMN "mime_type" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "source" text DEFAULT 'upload' NOT NULL;--> statement-breakpoint
ALTER TABLE "inbound_addresses" ADD CONSTRAINT "inbound_addresses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_address_id_inbound_addresses_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."inbound_addresses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_forwarder_user_id_users_id_fk" FOREIGN KEY ("forwarder_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_verdict_id_verdicts_id_fk" FOREIGN KEY ("verdict_id") REFERENCES "public"."verdicts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbound_addresses_tenant_idx" ON "inbound_addresses" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_addresses_one_active_per_tenant" ON "inbound_addresses" USING btree ("tenant_id") WHERE "inbound_addresses"."active";--> statement-breakpoint
CREATE INDEX "inbound_messages_tenant_received_idx" ON "inbound_messages" USING btree ("tenant_id","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "inbound_messages_address_received_idx" ON "inbound_messages" USING btree ("address_id","received_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "verdicts" ADD CONSTRAINT "verdicts_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "verdicts_tenant_source_created_idx" ON "verdicts" USING btree ("tenant_id","source","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "verdicts_artifact_idx" ON "verdicts" USING btree ("artifact_id");--> statement-breakpoint
ALTER TABLE "verdicts" ADD CONSTRAINT "verdicts_source_check" CHECK ("verdicts"."source" in ('chat', 'inbound', 'api'));--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_source_check" CHECK ("artifacts"."source" in ('upload', 'inbound'));--> statement-breakpoint

-- ── Row-level security for the new tenant-owned tables (same policy as 0001_rls) ──
ALTER TABLE "inbound_addresses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "inbound_addresses"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "inbound_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "inbound_messages"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── Pre-tenant lookups (security definer; see packages/db/docs/rls.md) ──
-- The inbound webhook must map a recipient local part to its tenant before any tenant is
-- known, and the retention job must find expired artifacts across tenants. Both run as the
-- app role, so these functions run as their owner (the migration role, which owns the
-- tables and is therefore not subject to RLS) and return only ids. search_path is pinned
-- so a caller cannot shadow the referenced objects.
CREATE FUNCTION "public"."resolve_inbound_address"(local_part text)
RETURNS TABLE(id uuid, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT a.id, a.tenant_id
  FROM public.inbound_addresses a
  WHERE a.local_part = lower(btrim($1)) AND a.active
  LIMIT 1
$$;--> statement-breakpoint
CREATE FUNCTION "public"."list_expired_artifacts"(max_rows integer)
RETURNS TABLE(id uuid, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT a.id, a.tenant_id
  FROM public.artifacts a
  WHERE a.expires_at IS NOT NULL AND a.expires_at <= now()
  ORDER BY a.expires_at
  LIMIT greatest(0, least(coalesce($1, 0), 1000))
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."resolve_inbound_address"(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."list_expired_artifacts"(integer) FROM PUBLIC;--> statement-breakpoint
-- Grant to the app role when it already exists (existing deployments). Fresh databases get
-- the grant from sql/create-app-user.sql, which runs after the first migration.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT EXECUTE ON FUNCTION "public"."resolve_inbound_address"(text) TO app_user;
    GRANT EXECUTE ON FUNCTION "public"."list_expired_artifacts"(integer) TO app_user;
  END IF;
END
$$;
