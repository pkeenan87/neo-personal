-- Member-only devices (_specs/v2-m2-child.md section 2, slice 1a). A device, its signals, its
-- enrollment codes and its monitoring token now belong to a `members` row; the account (`user_id`)
-- is optional, so a member without an account (a child) can be protected. No data is dropped except
-- device signals that belong to no member at all (see "Backfill").
--
-- Why `member_id` is not a plain NOT NULL on devices, codes and tokens: removing a person deletes
-- their `members` row, and their devices, codes and tokens are revoked rather than deleted. The FK
-- keeps `ON DELETE SET NULL` for those rows, so the invariant is "active rows have a member":
--   devices                  member_id IS NOT NULL OR revoked_at IS NOT NULL
--   device_enrollment_codes  member_id IS NOT NULL OR revoked_at IS NOT NULL OR redeemed_at IS NOT NULL
--   desktop_tokens           see desktop_tokens_subject_check
-- `device_signals.member_id` is plain NOT NULL with ON DELETE CASCADE (30-day telemetry).

-- ── New columns ──
ALTER TABLE "tenants" ADD COLUMN "time_zone" text;--> statement-breakpoint
ALTER TABLE "device_signals" ADD COLUMN "member_id" uuid;--> statement-breakpoint
ALTER TABLE "desktop_tokens" ADD COLUMN "member_id" uuid;--> statement-breakpoint
ALTER TABLE "device_signals" ADD CONSTRAINT "device_signals_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desktop_tokens" ADD CONSTRAINT "desktop_tokens_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- ── Backfill ──
-- Stragglers first: devices and codes 0017 did not reach (a user whose members row was created later).
UPDATE "devices" d SET "member_id" = mem."id"
FROM "members" mem
WHERE d."member_id" IS NULL AND mem."tenant_id" = d."tenant_id" AND mem."user_id" = d."user_id";--> statement-breakpoint
UPDATE "device_enrollment_codes" c SET "member_id" = mem."id"
FROM "members" mem
WHERE c."member_id" IS NULL AND mem."tenant_id" = c."tenant_id" AND mem."user_id" = c."user_id";--> statement-breakpoint
-- Fail loudly if an active device or a pending code still has no member.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM "devices" WHERE "member_id" IS NULL AND "revoked_at" IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION '0020_member_devices: % active device(s) have no members row; fix them or revoke them, then re-run', n;
  END IF;
  SELECT count(*) INTO n FROM "device_enrollment_codes" WHERE "member_id" IS NULL AND "revoked_at" IS NULL AND "redeemed_at" IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION '0020_member_devices: % pending enrollment code(s) have no members row; revoke them, then re-run', n;
  END IF;
END
$$;--> statement-breakpoint
-- Signals take their device's member, then their user's member. A signal whose member no longer
-- exists belongs to a removed person: it is deleted, exactly what the new ON DELETE CASCADE does.
UPDATE "device_signals" s SET "member_id" = d."member_id"
FROM "devices" d
WHERE s."member_id" IS NULL AND d."id" = s."device_id" AND d."tenant_id" = s."tenant_id" AND d."member_id" IS NOT NULL;--> statement-breakpoint
UPDATE "device_signals" s SET "member_id" = mem."id"
FROM "members" mem
WHERE s."member_id" IS NULL AND mem."tenant_id" = s."tenant_id" AND mem."user_id" = s."user_id";--> statement-breakpoint
DELETE FROM "device_signals" WHERE "member_id" IS NULL;--> statement-breakpoint
-- Monitoring tokens take their device's member.
UPDATE "desktop_tokens" t SET "member_id" = d."member_id"
FROM "devices" d
WHERE t."member_id" IS NULL AND t."device_id" IS NOT NULL AND d."id" = t."device_id" AND d."member_id" IS NOT NULL;--> statement-breakpoint
UPDATE "desktop_tokens" t SET "member_id" = mem."id"
FROM "members" mem
WHERE t."member_id" IS NULL AND t."device_id" IS NOT NULL AND mem."tenant_id" = t."tenant_id" AND mem."user_id" = t."user_id";--> statement-breakpoint
-- A live monitoring token with no member must not stay usable (fail closed).
UPDATE "desktop_tokens" SET "revoked_at" = now()
WHERE "device_id" IS NOT NULL AND "member_id" IS NULL AND "revoked_at" IS NULL;--> statement-breakpoint

-- ── Constraints ──
ALTER TABLE "device_signals" ALTER COLUMN "member_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "device_enrollment_codes" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "device_signals" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "desktop_tokens" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "desktop_tokens" ALTER COLUMN "role" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "desktop_tokens" DROP CONSTRAINT "desktop_tokens_role_check";--> statement-breakpoint
ALTER TABLE "desktop_tokens" ADD CONSTRAINT "desktop_tokens_role_check" CHECK ("desktop_tokens"."role" is null or "desktop_tokens"."role" in ('owner', 'member'));--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_member_check" CHECK ("devices"."member_id" is not null or "devices"."revoked_at" is not null);--> statement-breakpoint
ALTER TABLE "device_enrollment_codes" ADD CONSTRAINT "device_enrollment_codes_member_check" CHECK ("device_enrollment_codes"."member_id" is not null or "device_enrollment_codes"."revoked_at" is not null or "device_enrollment_codes"."redeemed_at" is not null);--> statement-breakpoint
-- A full token acts as a user (user and role set). A monitoring token has a device and a member
-- (the member may be gone once the token is revoked); its user and role are null for a member without an account.
ALTER TABLE "desktop_tokens" ADD CONSTRAINT "desktop_tokens_subject_check" CHECK (('full' = any("desktop_tokens"."scopes") and "desktop_tokens"."user_id" is not null and "desktop_tokens"."role" is not null)
        or ("desktop_tokens"."device_id" is not null and ("desktop_tokens"."member_id" is not null or "desktop_tokens"."revoked_at" is not null)));--> statement-breakpoint
CREATE INDEX "device_signals_tenant_member_observed_idx" ON "device_signals" USING btree ("tenant_id","member_id","observed_at" DESC NULLS LAST);--> statement-breakpoint

-- ── Rollout safety net ──
-- Code from before this release (still serving while the deploy rolls out) writes devices, codes,
-- signals and tokens with a user but no member. These triggers fill `member_id` from the same
-- tenant's data so those writes keep working. They are security definer with a pinned search_path
-- because they read `members` and `devices`, which have row-level security; they can be dropped
-- in a later release once every writer sets `member_id`.
CREATE FUNCTION "public"."default_member_from_user"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.member_id IS NULL AND NEW.user_id IS NOT NULL THEN
    SELECT m.id INTO NEW.member_id FROM public.members m WHERE m.tenant_id = NEW.tenant_id AND m.user_id = NEW.user_id;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE FUNCTION "public"."default_member_from_device"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.member_id IS NULL AND NEW.device_id IS NOT NULL THEN
    SELECT d.member_id INTO NEW.member_id FROM public.devices d WHERE d.id = NEW.device_id AND d.tenant_id = NEW.tenant_id;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."default_member_from_user"() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."default_member_from_device"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "devices_default_member" BEFORE INSERT ON "devices" FOR EACH ROW EXECUTE FUNCTION "public"."default_member_from_user"();--> statement-breakpoint
CREATE TRIGGER "device_enrollment_codes_default_member" BEFORE INSERT ON "device_enrollment_codes" FOR EACH ROW EXECUTE FUNCTION "public"."default_member_from_user"();--> statement-breakpoint
CREATE TRIGGER "device_signals_default_member" BEFORE INSERT ON "device_signals" FOR EACH ROW EXECUTE FUNCTION "public"."default_member_from_device"();--> statement-breakpoint
CREATE TRIGGER "desktop_tokens_default_member" BEFORE INSERT ON "desktop_tokens" FOR EACH ROW EXECUTE FUNCTION "public"."default_member_from_device"();
