-- Uninstall signal (_specs/browser-extension.md "Uninstall"): POST /api/devices/uninstalled has
-- no session, only a device id and an HMAC signature from that device's own heartbeat response.
-- lookup_device_tenant resolves the tenant for an ACTIVE device only, mirroring
-- lookup_device_enrollment_code (0009): an unknown or already-revoked device returns no row, so
-- a forged or repeated report is a safe no-op. No table or column changes.
CREATE FUNCTION "public"."lookup_device_tenant"(device_id uuid)
RETURNS TABLE(tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT d.tenant_id
  FROM public.devices d
  WHERE d.id = $1
    AND d.revoked_at IS NULL
  LIMIT 1
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."lookup_device_tenant"(uuid) FROM PUBLIC;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT EXECUTE ON FUNCTION "public"."lookup_device_tenant"(uuid) TO app_user;
  END IF;
END
$$;
