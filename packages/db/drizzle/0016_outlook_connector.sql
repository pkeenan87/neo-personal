CREATE TABLE "outlook_connectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"microsoft_user_id" text NOT NULL,
	"display_address" text NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"token_version" integer DEFAULT 1 NOT NULL,
	"connection_generation" integer DEFAULT 1 NOT NULL,
	"encrypted_tokens" "bytea",
	"encrypted_delta_cursor" "bytea",
	"last_audit_at" timestamp with time zone,
	"last_poll_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outlook_connectors_status_check" CHECK ("outlook_connectors"."status" in ('connected', 'reauth_required', 'paused', 'disconnected'))
);
--> statement-breakpoint
CREATE TABLE "outlook_oauth_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"state_hash" "bytea" NOT NULL,
	"encrypted_pkce_verifier" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outlook_rule_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"connector_id" uuid NOT NULL,
	"rule_key" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"action" text NOT NULL,
	"destination_domain" text,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"alerted_at" timestamp with time zone,
	CONSTRAINT "outlook_rule_findings_state_check" CHECK ("outlook_rule_findings"."state" in ('active', 'resolved')),
	CONSTRAINT "outlook_rule_findings_action_check" CHECK ("outlook_rule_findings"."action" in ('forward_to', 'redirect_to', 'forward_as_attachment_to'))
);
--> statement-breakpoint
CREATE TABLE "outlook_seen_messages" (
	"tenant_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"message_key" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outlook_seen_messages_pk" PRIMARY KEY("connector_id","message_key")
);
--> statement-breakpoint
ALTER TABLE "alerts" DROP CONSTRAINT "alerts_kind_check";--> statement-breakpoint
ALTER TABLE "outlook_connectors" ADD CONSTRAINT "outlook_connectors_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outlook_connectors" ADD CONSTRAINT "outlook_connectors_membership_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."memberships"("tenant_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outlook_oauth_states" ADD CONSTRAINT "outlook_oauth_states_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outlook_oauth_states" ADD CONSTRAINT "outlook_oauth_states_membership_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."memberships"("tenant_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outlook_rule_findings" ADD CONSTRAINT "outlook_rule_findings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outlook_rule_findings" ADD CONSTRAINT "outlook_rule_findings_membership_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."memberships"("tenant_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "outlook_connectors_tenant_id_idx" ON "outlook_connectors" USING btree ("tenant_id","id");--> statement-breakpoint
ALTER TABLE "outlook_rule_findings" ADD CONSTRAINT "outlook_rule_findings_connector_fk" FOREIGN KEY ("tenant_id","connector_id") REFERENCES "public"."outlook_connectors"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outlook_seen_messages" ADD CONSTRAINT "outlook_seen_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outlook_seen_messages" ADD CONSTRAINT "outlook_seen_messages_connector_fk" FOREIGN KEY ("tenant_id","connector_id") REFERENCES "public"."outlook_connectors"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "outlook_connectors_user_idx" ON "outlook_connectors" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outlook_oauth_states_hash_idx" ON "outlook_oauth_states" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX "outlook_oauth_states_expires_idx" ON "outlook_oauth_states" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "outlook_rule_findings_rule_idx" ON "outlook_rule_findings" USING btree ("tenant_id","connector_id","rule_key");--> statement-breakpoint
CREATE INDEX "outlook_rule_findings_user_idx" ON "outlook_rule_findings" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "outlook_seen_messages_seen_idx" ON "outlook_seen_messages" USING btree ("connector_id","seen_at");--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_kind_check" CHECK ("alerts"."kind" in ('member_verdict', 'member_joined', 'member_left', 'device_enrolled', 'device_offline', 'device_removed', 'scam_page', 'dangerous_site', 'remote_access', 'unwanted_software', 'permission_grant', 'scam_in_progress', 'breach_detected', 'mailbox_forwarding'));
--> statement-breakpoint
ALTER TABLE outlook_oauth_states ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON outlook_oauth_states
USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE outlook_connectors ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON outlook_connectors
USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE outlook_rule_findings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON outlook_rule_findings
USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE outlook_seen_messages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON outlook_seen_messages
USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.outlook_oauth_states TO app_user;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.outlook_connectors TO app_user;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.outlook_rule_findings TO app_user;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.outlook_seen_messages TO app_user;
  END IF;
END $$;
--> statement-breakpoint
-- Cross-tenant discovery for the 15-minute poll and daily audit crons (no tenant is known yet). Returns identifiers only.
CREATE FUNCTION public.list_outlook_connectors(cursor_tenant_id uuid, cursor_user_id text, page_limit integer)
RETURNS TABLE(tenant_id uuid, user_id text, connector_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT c.tenant_id, c.user_id, c.id
  FROM public.outlook_connectors c
  WHERE c.status = 'connected'
    AND ($1 IS NULL OR (c.tenant_id, c.user_id) > ($1, $2))
  ORDER BY c.tenant_id, c.user_id
  LIMIT LEAST(GREATEST(COALESCE($3, 1000), 1), 1000)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.list_outlook_connectors(uuid, text, integer) FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT EXECUTE ON FUNCTION public.list_outlook_connectors(uuid, text, integer) TO app_user;
  END IF;
END $$;
