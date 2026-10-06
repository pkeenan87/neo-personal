CREATE TABLE "account_hardening_answers" (
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"item_id" text NOT NULL,
	"answer" boolean,
	"not_applicable" boolean DEFAULT false NOT NULL,
	"checklist_version" text NOT NULL,
	"answered_at" timestamp with time zone NOT NULL,
	CONSTRAINT "account_hardening_answers_pk" PRIMARY KEY("tenant_id","user_id","item_id"),
	CONSTRAINT "account_hardening_answers_item_check" CHECK ("account_hardening_answers"."item_id" in ('primary_email_2fa', 'passkey_or_hardware_key', 'recovery_contacts_current', 'password_manager', 'carrier_port_out_pin', 'credit_freeze', 'os_browser_auto_update', 'desktop_agent_enrolled')),
	CONSTRAINT "account_hardening_answers_value_check" CHECK (("account_hardening_answers"."not_applicable" and "account_hardening_answers"."answer" is null) or (not "account_hardening_answers"."not_applicable" and "account_hardening_answers"."answer" is not null)),
	CONSTRAINT "account_hardening_answers_na_check" CHECK (not "account_hardening_answers"."not_applicable" or "account_hardening_answers"."item_id" in ('credit_freeze', 'carrier_port_out_pin', 'desktop_agent_enrolled')),
	CONSTRAINT "account_hardening_answers_desktop_na_only_check" CHECK ("account_hardening_answers"."item_id" <> 'desktop_agent_enrolled' or "account_hardening_answers"."not_applicable")
);
--> statement-breakpoint
ALTER TABLE "account_hardening_answers" ADD CONSTRAINT "account_hardening_answers_membership_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."memberships"("tenant_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE account_hardening_answers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON account_hardening_answers
USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.account_hardening_answers TO app_user;
  END IF;
END $$;
