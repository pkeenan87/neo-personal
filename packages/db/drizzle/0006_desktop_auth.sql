CREATE TABLE "desktop_auth_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_code" text NOT NULL,
	"device_code_hash" text NOT NULL,
	"client_name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"user_id" text,
	"tenant_id" uuid,
	"role" text,
	"user_email" text,
	"user_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "desktop_auth_requests_user_code_unique" UNIQUE("user_code"),
	CONSTRAINT "desktop_auth_requests_device_code_hash_unique" UNIQUE("device_code_hash"),
	CONSTRAINT "desktop_auth_requests_status_check" CHECK ("desktop_auth_requests"."status" in ('pending', 'approved', 'denied')),
	CONSTRAINT "desktop_auth_requests_role_check" CHECK ("desktop_auth_requests"."role" is null or "desktop_auth_requests"."role" in ('owner', 'member'))
);
--> statement-breakpoint
ALTER TABLE "desktop_auth_requests" ADD CONSTRAINT "desktop_auth_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desktop_auth_requests" ADD CONSTRAINT "desktop_auth_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "desktop_auth_requests_expires_idx" ON "desktop_auth_requests" USING btree ("expires_at");