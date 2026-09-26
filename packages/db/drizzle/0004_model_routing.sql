-- Phase 2 model routing. New columns only: memberships, turns and usage_events already carry
-- tenant_id and the tenant_isolation policy from 0001_rls (all commands), so no new RLS policy.
ALTER TABLE "memberships" ADD COLUMN "routing_preference" text DEFAULT 'balanced' NOT NULL;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "model_family" text DEFAULT 'anthropic' NOT NULL;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "route" jsonb;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "tier" text;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_routing_preference_check" CHECK ("memberships"."routing_preference" in ('cost', 'balanced', 'intelligence'));--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_model_family_check" CHECK ("memberships"."model_family" in ('anthropic', 'openai', 'kimi', 'grok'));--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_tier_check" CHECK ("usage_events"."tier" is null or "usage_events"."tier" in ('small', 'medium', 'large'));