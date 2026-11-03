/**
 * Signed policy bundle cache (_specs/v2-m2-child.md section 4): the last bundle compiled and signed
 * for a device, so the signing key is used only when the policy changes or the bundle nears expiry.
 * Tenant-scoped; the row goes with the device (ON DELETE CASCADE).
 */
import { eq } from "drizzle-orm";
import { policyBundles } from "./schema/index.js";
import { assertTenantId, tenantScoped } from "./tenant.js";
import type { Db } from "./client.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PolicyBundleRow {
  deviceId: string;
  policyVersion: string;
  bundle: Record<string, unknown>;
  sig: string;
  keyId: string;
  issuedAt: Date;
  expiresAt: Date;
}

function toRow(r: typeof policyBundles.$inferSelect): PolicyBundleRow {
  return { deviceId: r.deviceId, policyVersion: r.policyVersion, bundle: r.bundle, sig: r.sig, keyId: r.keyId, issuedAt: r.issuedAt, expiresAt: r.expiresAt };
}

/** The stored bundle of a device in this household, or undefined. */
export async function getPolicyBundle(db: Db, tenantId: string, deviceId: string): Promise<PolicyBundleRow | undefined> {
  assertTenantId(tenantId);
  if (!UUID_RE.test(deviceId)) return undefined;
  const row = await tenantScoped(db, tenantId).first(policyBundles, eq(policyBundles.deviceId, deviceId));
  return row ? toRow(row) : undefined;
}

/**
 * Store (insert or replace) the signed bundle of a device. A device id that is not in the
 * household fails the foreign key or the row-level security check, so nothing leaks across tenants.
 */
export async function upsertPolicyBundle(db: Db, tenantId: string, input: PolicyBundleRow): Promise<void> {
  assertTenantId(tenantId);
  if (!UUID_RE.test(input.deviceId)) throw new Error("@neo/db: invalid device id");
  await tenantScoped(db, tenantId).transaction(async (t) => {
    const values = { tenantId, ...input };
    const stored = await t.tx
      .insert(policyBundles)
      .values(values)
      .onConflictDoUpdate({
        target: policyBundles.deviceId,
        set: { policyVersion: input.policyVersion, bundle: input.bundle, sig: input.sig, keyId: input.keyId, issuedAt: input.issuedAt, expiresAt: input.expiresAt },
        // Defense in depth on top of RLS: only ever replace a row of this tenant.
        setWhere: eq(policyBundles.tenantId, tenantId),
      })
      .returning({ deviceId: policyBundles.deviceId });
    // A device of another household conflicts but is not replaced (setWhere): report it rather than pretend it was stored.
    if (stored.length === 0) throw new Error("@neo/db: device is not in this household");
  });
}
