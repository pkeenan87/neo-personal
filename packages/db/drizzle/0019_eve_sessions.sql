-- Owner of each eve agent session (_specs/v2-m1-elder.md section 7): eve has no per-session access
-- list, so the channel records who created a session and only that tenant and user may continue it.
CREATE TABLE "eve_sessions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "eve_sessions" ADD CONSTRAINT "eve_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eve_sessions" ADD CONSTRAINT "eve_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "eve_sessions_tenant_user_idx" ON "eve_sessions" USING btree ("tenant_id","user_id");--> statement-breakpoint
-- ── Row-level security (same policy as 0001_rls) ──
ALTER TABLE "eve_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "eve_sessions"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
