/**
 * Policy bundle cache (_specs/v2-m2-child.md section 4; migration 0022) on PGlite as the non-owner app
 * role: the table is tenant-isolated and keyed by device, an upsert replaces the row, it goes with the
 * device, and a heartbeat stores the version the device reports applying.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEnrollmentCode, getDevice, recordHeartbeat, redeemEnrollmentCode, type DeviceInput } from "../src/devices.js";
import { getPolicyBundle, upsertPolicyBundle, type PolicyBundleRow } from "../src/policy-bundles.js";
import { devices, members, policyBundles } from "../src/schema/index.js";
import { tenantScoped, tenantTables } from "../src/tenant.js";
import { createTenantForUser } from "../src/tenants.js";
import { becomeAppUser, createTestDb, createUser, type TestDb } from "./helpers.js";

const DEVICE: DeviceInput = { kind: "browser_extension", platform: "chrome", name: "Chrome on Sam's PC", clientVersion: "1.0.0" };

let t: TestDb;
let tenantId: string;
let otherTenantId: string;
let ownerId: string;
let deviceId: string;

function row(over: Partial<PolicyBundleRow> = {}): PolicyBundleRow {
  return {
    deviceId,
    policyVersion: "a".repeat(64),
    bundle: { v: 1, deviceId, policyVersion: "a".repeat(64) },
    sig: "c2ln",
    keyId: "key-1",
    issuedAt: new Date("2026-11-02T12:00:00.000Z"),
    expiresAt: new Date("2026-11-09T12:00:00.000Z"),
    ...over,
  };
}

beforeAll(async () => {
  t = await createTestDb({ createAppUserBeforeMigrations: true });
  ownerId = await createUser(t.db, "Pat");
  tenantId = (await createTenantForUser(t.db, { userId: ownerId, name: "Pat's household" })).tenantId;
  const other = await createUser(t.db, "Zed");
  otherTenantId = (await createTenantForUser(t.db, { userId: other, name: "Zed's household" })).tenantId;
  await becomeAppUser(t.client);
  const [sam] = await tenantScoped(t.db, tenantId).insert(members, { userId: null, displayName: "Sam", role: "child", mode: "child", birthYear: 2015 });
  const made = await createEnrollmentCode(t.db, { tenantId, memberId: sam!.id, createdBy: ownerId });
  if ("error" in made) throw new Error(made.error);
  const r = await redeemEnrollmentCode(t.db, { code: made.code, device: DEVICE });
  if (r.status !== "enrolled") throw new Error(r.status);
  deviceId = r.device.id;
}, 60_000);
afterAll(async () => {
  await t?.close();
});

describe("migration 0022", () => {
  it("creates policy_bundles with row-level security and a tenant policy, in tenantTables", async () => {
    const rls = await t.client.query<{ relrowsecurity: boolean }>(`select relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relname = 'policy_bundles'`);
    expect(rls.rows[0]?.relrowsecurity).toBe(true);
    const pol = await t.client.query<{ qual: string }>(`select qual from pg_policies where schemaname = 'public' and tablename = 'policy_bundles' and policyname = 'tenant_isolation'`);
    expect(pol.rows[0]?.qual).toContain("current_setting('app.tenant_id'::text, true)");
    expect(tenantTables.policyBundles).toBe(policyBundles);
  });

  it("adds devices.policy_version_applied, null for a new device", async () => {
    const d = await getDevice(t.db, tenantId, deviceId);
    expect(d?.policyVersionApplied).toBeNull();
    const col = await t.client.query<{ is_nullable: string }>(`select is_nullable from information_schema.columns where table_name = 'devices' and column_name = 'policy_version_applied'`);
    expect(col.rows[0]?.is_nullable).toBe("YES");
  });
});

describe("policy bundle cache", () => {
  it("returns nothing before a bundle is stored", async () => {
    expect(await getPolicyBundle(t.db, tenantId, deviceId)).toBeUndefined();
    expect(await getPolicyBundle(t.db, tenantId, "not-a-uuid")).toBeUndefined();
  });

  it("stores, then replaces, the one row of a device", async () => {
    await upsertPolicyBundle(t.db, tenantId, row());
    expect(await getPolicyBundle(t.db, tenantId, deviceId)).toMatchObject({ policyVersion: "a".repeat(64), keyId: "key-1", sig: "c2ln" });
    await upsertPolicyBundle(t.db, tenantId, row({ policyVersion: "b".repeat(64), keyId: "key-2", sig: "bmV3" }));
    expect(await getPolicyBundle(t.db, tenantId, deviceId)).toMatchObject({ policyVersion: "b".repeat(64), keyId: "key-2", sig: "bmV3", expiresAt: new Date("2026-11-09T12:00:00.000Z") });
    expect(await tenantScoped(t.db, tenantId).count(policyBundles)).toBe(1);
  });

  it("is invisible to another household, and another household cannot write for this device", async () => {
    expect(await getPolicyBundle(t.db, otherTenantId, deviceId)).toBeUndefined();
    expect(await tenantScoped(t.db, otherTenantId).select(policyBundles)).toEqual([]);
    await expect(upsertPolicyBundle(t.db, otherTenantId, row())).rejects.toThrow();
    expect(await getPolicyBundle(t.db, tenantId, deviceId)).toMatchObject({ keyId: "key-2" });
  });

  it("is removed with its device", async () => {
    const [spare] = await tenantScoped(t.db, tenantId).insert(devices, { userId: null, memberId: (await tenantScoped(t.db, tenantId).select(members, eq(members.displayName, "Sam")))[0]!.id, kind: "desktop_agent", platform: "windows", name: "Spare", clientVersion: "1", enrollment: "code" });
    await upsertPolicyBundle(t.db, tenantId, row({ deviceId: spare!.id }));
    expect(await getPolicyBundle(t.db, tenantId, spare!.id)).toBeDefined();
    await tenantScoped(t.db, tenantId).delete(devices, eq(devices.id, spare!.id));
    expect(await getPolicyBundle(t.db, tenantId, spare!.id)).toBeUndefined();
  });
});

describe("heartbeat", () => {
  it("stores the applied version, keeps it when a later heartbeat omits it, and replaces it", async () => {
    const first = await recordHeartbeat(t.db, { tenantId, deviceId, policyVersion: "d".repeat(64) });
    expect(first?.policyVersionApplied).toBe("d".repeat(64));
    const omitted = await recordHeartbeat(t.db, { tenantId, deviceId, clientVersion: "1.1.0" });
    expect(omitted?.policyVersionApplied).toBe("d".repeat(64));
    const next = await recordHeartbeat(t.db, { tenantId, deviceId, policyVersion: "e".repeat(64) });
    expect(next?.policyVersionApplied).toBe("e".repeat(64));
  });
});
