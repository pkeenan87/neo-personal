-- Desktop / shell personal access tokens. User-owned (no RLS): looked up by
-- token_hash before a tenant context exists, same pattern as Auth.js sessions.
CREATE TABLE "desktop_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	"role" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "desktop_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "desktop_tokens_role_check" CHECK ("desktop_tokens"."role" in ('owner', 'member'))
);
--> statement-breakpoint
ALTER TABLE "desktop_tokens" ADD CONSTRAINT "desktop_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desktop_tokens" ADD CONSTRAINT "desktop_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "desktop_tokens_user_idx" ON "desktop_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "desktop_tokens_tenant_idx" ON "desktop_tokens" USING btree ("tenant_id");
