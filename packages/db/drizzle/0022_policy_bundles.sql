-- Policy bundles (_specs/v2-m2-child.md section 4, slice 2): the last signed bundle per device, so the
-- signing key is called only when the policy changes or the bundle nears expiry, and the version a
-- device reports applying (devices.policy_version_applied, from its heartbeat). Additive; no data is changed.

CREATE TABLE "policy_bundles" (
	"device_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"policy_version" text NOT NULL,
	"bundle" jsonb NOT NULL,
	"sig" text NOT NULL,
	"key_id" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "policy_version_applied" text;--> statement-breakpoint
ALTER TABLE "policy_bundles" ADD CONSTRAINT "policy_bundles_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_bundles" ADD CONSTRAINT "policy_bundles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "policy_bundles_tenant_idx" ON "policy_bundles" USING btree ("tenant_id");
--> statement-breakpoint
-- ── Row-level security (same policy as 0001_rls) ──
ALTER TABLE "policy_bundles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "policy_bundles"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
