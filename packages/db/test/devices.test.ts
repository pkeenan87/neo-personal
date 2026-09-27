/**
 * Devices, enrollment codes and scoped desktop tokens on PGlite with the committed
 * migrations, running as the non-owner app role so RLS and the security-definer
 * functions are exercised.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDesktopAuthRequest, decideDesktopAuthRequest, getDesktopAuthRequest, redeemDesktopAuthRequest } from "../src/desktop-auth.js";
import { createDesktopToken, listDesktopTokens, resolveDesktopToken } from "../src/desktop-tokens.js";
import {
  DEVICE_OFFLINE_AFTER_MS,
  ENROLLMENT_CODE_TTL_MS,
  MAX_DEVICES_PER_HOUSEHOLD,
  MAX_PENDING_ENROLLMENT_CODES,
  createEnrollmentCode,
  enrollSelfDevice,
  getDevice,
  hashEnrollmentCode,
  listDevices,
  listPendingEnrollmentCodes,
  listStaleDevices,
  markDeviceOfflineAlerted,
  mintEnrollmentCode,
  normalizeDeviceName,
  normalizeEnrollmentCode,
  previewEnrollmentCode,
  purgeOldDevices,
  recordHeartbeat,
  redeemEnrollmentCode,
  renameDevice,
  revokeDevice,
  revokeEnrollmentCode,
  type DeviceInput,
} from "../src/devices.js";
import { leaveHousehold, removeHouseholdMember } from "../src/household.js";
import * as schema from "../src/schema/index.js";
import { auditEvents, deviceEnrollmentCodes, desktopTokens, devices, memberships, users } from "../src/schema/index.js";
import { tenantScoped } from "../src/tenant.js";
import { createTenantForUser } from "../src/tenants.js";
import { becomeAppUser, createTestDb, type TestDb } from "./helpers.js";

const DEVICE: DeviceInput = { kind: "browser_extension", platform: "chrome", name: "Chrome on Grandma's laptop", clientVersion: "0.1.0" };
const DAY = 24 * 60 * 60 * 1000;

let seq = 0;

async function household(t: TestDb) {
  seq += 1;
  const [row] = await t.db.insert(users).values({ name: `Owner ${seq}`, email: `owner${seq}-${Date.now()}@example.test` }).returning({ id: users.id });
  const ownerId = row!.id;
  const { tenantId } = await createTenantForUser(t.db, { userId: ownerId, name: `Household ${seq}` });
  return { ownerId, tenantId };
}

async function addMember(t: TestDb, tenantId: string, name = "Grandma") {
  seq += 1;
  const [row] = await t.db.insert(users).values({ name, email: `member${seq}-${Date.now()}@example.test` }).returning({ id: users.id });
  await tenantScoped(t.db, tenantId).insert(memberships, { userId: row!.id, role: "member" });
  return row!.id;
}

async function newCode(t: TestDb, tenantId: string, userId: string, createdBy: string, now?: Date) {
  const r = await createEnrollmentCode(t.db, { tenantId, userId, createdBy, now });
  if ("error" in r) throw new Error(r.error);
  return r;
}

/** Enroll a device by code; `createdAt` backdates the device (the code lookup uses the real clock). */
async function enrolled(t: TestDb, tenantId: string, userId: string, createdBy: string, createdAt?: Date) {
  const { code } = await newCode(t, tenantId, userId, createdBy);
  const r = await redeemEnrollmentCode(t.db, { code, device: DEVICE });
  if (r.status !== "enrolled") throw new Error(r.status);
  if (createdAt) await tenantScoped(t.db, tenantId).update(devices, { createdAt }, eq(devices.id, r.device.id));
  return r;
}

describe("enrollment codes and device input", () => {
  it("mints XXXX-XXXX-XXXX codes and normalizes typed input", () => {
    const code = mintEnrollmentCode();
    expect(code).toMatch(/^[BCDFGHJKMNPQRTWXYZ2346789]{4}(-[BCDFGHJKMNPQRTWXYZ2346789]{4}){2}$/);
    expect(normalizeEnrollmentCode(code.toLowerCase().replace(/-/g, " "))).toBe(code);
    expect(normalizeEnrollmentCode(code.replace(/-/g, ""))).toBe(code);
    expect(normalizeEnrollmentCode("AAAA-AAAA-AAAA")).toBeNull(); // vowel: not in the alphabet
    expect(normalizeEnrollmentCode("BCDF-GHJK")).toBeNull();
    expect(hashEnrollmentCode(code.toLowerCase())).toBe(hashEnrollmentCode(code));
  });

  it("normalizes device names", () => {
    expect(normalizeDeviceName("  Chrome \n on\tlaptop ")).toBe("Chrome on laptop");
    expect(normalizeDeviceName("   ")).toBeNull();
    expect(normalizeDeviceName("x".repeat(65))).toBeNull();
    expect(normalizeDeviceName("x".repeat(64))).toHaveLength(64);
  });
});

describe("devices (PGlite as app_user)", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
    await becomeAppUser(t.client);
  });
  afterAll(async () => {
    await t.close();
  });

  it("creates, lists and revokes codes; refuses non-members and the pending-code cap", async () => {
    const { ownerId, tenantId } = await household(t);
    const memberId = await addMember(t, tenantId);
    const other = await household(t);

    expect(await createEnrollmentCode(t.db, { tenantId, userId: other.ownerId, createdBy: ownerId })).toEqual({ error: "not_member" });

    const first = await newCode(t, tenantId, memberId, ownerId);
    expect(first.record).toMatchObject({ userId: memberId, memberName: "Grandma", createdBy: ownerId });
    expect(first.record.expiresAt.getTime() - first.record.createdAt.getTime()).toBe(ENROLLMENT_CODE_TTL_MS);
    // The owner may generate one for themselves.
    await newCode(t, tenantId, ownerId, ownerId);
    for (let i = 2; i < MAX_PENDING_ENROLLMENT_CODES; i++) await newCode(t, tenantId, memberId, ownerId);
    expect(await createEnrollmentCode(t.db, { tenantId, userId: memberId, createdBy: ownerId })).toEqual({ error: "code_limit" });

    const pending = await listPendingEnrollmentCodes(t.db, tenantId);
    expect(pending).toHaveLength(MAX_PENDING_ENROLLMENT_CODES);
    expect(pending.at(-1)!.id).toBe(first.record.id); // newest first
    expect(pending[0]).not.toHaveProperty("codeHash");

    expect(await revokeEnrollmentCode(t.db, tenantId, first.record.id)).toBe(true);
    expect(await revokeEnrollmentCode(t.db, tenantId, first.record.id)).toBe(true);
    expect(await revokeEnrollmentCode(t.db, tenantId, "00000000-0000-4000-8000-000000000000")).toBe(false);
    // Another household cannot see or revoke it.
    expect(await revokeEnrollmentCode(t.db, other.tenantId, pending[0]!.id)).toBe(false);
    expect(await listPendingEnrollmentCodes(t.db, other.tenantId)).toEqual([]);
    expect(await previewEnrollmentCode(t.db, { code: first.code })).toBeNull();
    expect((await redeemEnrollmentCode(t.db, { code: first.code, device: DEVICE })).status).toBe("not_found");
  });

  it("previews and redeems a code once into a device and a monitoring token", async () => {
    const { ownerId, tenantId } = await household(t);
    const memberId = await addMember(t, tenantId);
    const { code } = await newCode(t, tenantId, memberId, ownerId);

    const preview = await previewEnrollmentCode(t.db, { code: code.toLowerCase().replace(/-/g, " ") });
    expect(preview).toMatchObject({ householdName: expect.stringMatching(/^Household/), memberName: "Grandma", ownerName: expect.stringMatching(/^Owner/) });

    const r = await redeemEnrollmentCode(t.db, { code, device: { ...DEVICE, name: "  Chrome   on laptop " } });
    if (r.status !== "enrolled") throw new Error(r.status);
    expect(r.device).toMatchObject({
      tenantId,
      userId: memberId,
      memberName: "Grandma",
      name: "Chrome on laptop",
      enrollment: "code",
      enrolledBy: ownerId,
      lastSeenAt: null,
      revokedAt: null,
    });
    expect(r.memberName).toBe("Grandma");
    expect(r.createdBy).toBe(ownerId);

    const resolved = await resolveDesktopToken(t.db, r.token);
    expect(resolved).toMatchObject({ id: r.tokenId, userId: memberId, tenantId, role: "member", deviceId: r.device.id });
    expect(resolved!.scopes.sort()).toEqual(["device", "signals:write", "url:check"]);

    // Single use.
    expect((await redeemEnrollmentCode(t.db, { code, device: DEVICE })).status).toBe("not_found");
    expect(await previewEnrollmentCode(t.db, { code })).toBeNull();

    const [codeRow] = await tenantScoped(t.db, tenantId).select(deviceEnrollmentCodes);
    expect(codeRow).toMatchObject({ deviceId: r.device.id });
    expect(codeRow!.redeemedAt).toBeInstanceOf(Date);
    const audit = await tenantScoped(t.db, tenantId).select(auditEvents, eq(auditEvents.eventType, "device.enrolled"));
    expect(audit[0]!.metadata).toEqual({ deviceId: r.device.id, userId: memberId, enrollment: "code" });

    // Monitoring tokens are managed as devices, not listed as desktop tokens.
    expect(await listDesktopTokens(t.db, memberId)).toEqual([]);
  });

  it("lets exactly one of two concurrent redemptions win", async () => {
    const { ownerId, tenantId } = await household(t);
    const memberId = await addMember(t, tenantId);
    const { code } = await newCode(t, tenantId, memberId, ownerId);
    const results = await Promise.all([
      redeemEnrollmentCode(t.db, { code, device: DEVICE }),
      redeemEnrollmentCode(t.db, { code, device: DEVICE }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["enrolled", "not_found"]);
    expect(await listDevices(t.db, tenantId)).toHaveLength(1);
  });

  it("refuses expired codes, bad device input, and members removed before redemption", async () => {
    const { ownerId, tenantId } = await household(t);
    const memberId = await addMember(t, tenantId);

    const old = await newCode(t, tenantId, memberId, ownerId, new Date(Date.now() - ENROLLMENT_CODE_TTL_MS - 1000));
    expect(await previewEnrollmentCode(t.db, { code: old.code })).toBeNull();
    expect((await redeemEnrollmentCode(t.db, { code: old.code, device: DEVICE })).status).toBe("not_found");

    const { code } = await newCode(t, tenantId, memberId, ownerId);
    for (const bad of [
      { ...DEVICE, kind: "toaster" },
      { ...DEVICE, platform: "amiga" },
      { ...DEVICE, name: " " },
      { ...DEVICE, name: "x".repeat(65) },
      { ...DEVICE, clientVersion: "" },
      { ...DEVICE, clientVersion: "1".repeat(33) },
    ]) {
      expect((await redeemEnrollmentCode(t.db, { code, device: bad as DeviceInput })).status).toBe("invalid");
    }
    expect((await redeemEnrollmentCode(t.db, { code: "nope", device: DEVICE })).status).toBe("not_found");

    // Removing the member revokes their pending codes.
    expect((await removeHouseholdMember(t.db, { tenantId, userId: memberId, removedBy: ownerId })).status).toBe("removed");
    expect((await redeemEnrollmentCode(t.db, { code, device: DEVICE })).status).toBe("not_found");
    expect(await listPendingEnrollmentCodes(t.db, tenantId)).toEqual([]);
  });

  it("re-checks membership at redemption even if the code is still pending", async () => {
    const { ownerId, tenantId } = await household(t);
    const memberId = await addMember(t, tenantId);
    const { code } = await newCode(t, tenantId, memberId, ownerId);
    // Membership gone without detachMember (e.g. a direct delete): the code alone is not enough.
    await tenantScoped(t.db, tenantId).delete(memberships, eq(memberships.userId, memberId));
    expect(await previewEnrollmentCode(t.db, { code })).toBeNull();
    expect((await redeemEnrollmentCode(t.db, { code, device: DEVICE })).status).toBe("not_found");
  });

  it("caps active devices per household", async () => {
    const { ownerId, tenantId } = await household(t);
    const scoped = tenantScoped(t.db, tenantId);
    await scoped.insert(
      devices,
      Array.from({ length: MAX_DEVICES_PER_HOUSEHOLD - 1 }, (_, i) => ({ userId: ownerId, kind: "desktop_agent" as const, platform: "linux" as const, name: `PC ${i}`, clientVersion: "1", enrollment: "self" as const })),
    );
    const { code } = await newCode(t, tenantId, ownerId, ownerId);
    expect((await redeemEnrollmentCode(t.db, { code, device: DEVICE })).status).toBe("enrolled");
    expect(await createEnrollmentCode(t.db, { tenantId, userId: ownerId, createdBy: ownerId })).toEqual({ error: "device_limit" });
    expect(await enrollSelfDevice(t.db, { tenantId, userId: ownerId, role: "owner", device: DEVICE })).toEqual({ error: "device_limit" });
  });

  it("enforces the scope check constraints and defaults existing-style tokens to full", async () => {
    const { ownerId, tenantId } = await household(t);
    const full = await createDesktopToken(t.db, { userId: ownerId, tenantId, role: "owner", name: "Omarchy bar" });
    if ("error" in full) throw new Error(full.error);
    expect(await resolveDesktopToken(t.db, full.token)).toMatchObject({ scopes: ["full"], deviceId: null });
    expect(await listDesktopTokens(t.db, ownerId)).toHaveLength(1);

    const { device } = await enrolled(t, tenantId, ownerId, ownerId);
    const base = { userId: ownerId, tenantId, role: "owner" as const, name: "x", tokenPrefix: "abcdefgh" };
    let n = 0;
    const insert = (v: Partial<typeof desktopTokens.$inferInsert>) =>
      t.db.insert(desktopTokens).values({ ...base, tokenHash: `scope-test-${++n}`, ...v }).returning({ scopes: desktopTokens.scopes });
    await expect(insert({ scopes: ["full"], deviceId: device.id })).rejects.toThrow();
    await expect(insert({ scopes: ["device"] })).rejects.toThrow();
    await expect(insert({ scopes: ["bogus" as "full"] })).rejects.toThrow();
    await expect(insert({ scopes: [], deviceId: device.id })).rejects.toThrow();
    expect(await insert({ scopes: ["device"], deviceId: device.id })).toEqual([{ scopes: ["device"] }]);
    // An insert that names no scopes (every pre-0009 code path) is a full token.
    expect(await insert({})).toEqual([{ scopes: ["full"] }]);
  });

  it("stops resolving a device's token after revokeDevice, idempotently", async () => {
    const { ownerId, tenantId } = await household(t);
    const memberId = await addMember(t, tenantId);
    const r = await enrolled(t, tenantId, memberId, ownerId);
    expect(await resolveDesktopToken(t.db, r.token)).not.toBeNull();

    const first = await revokeDevice(t.db, { tenantId, deviceId: r.device.id, revokedBy: memberId });
    expect(first).toMatchObject({ alreadyRevoked: false, device: { id: r.device.id, revokedAt: expect.any(Date) } });
    expect(await resolveDesktopToken(t.db, r.token)).toBeNull();
    expect((await revokeDevice(t.db, { tenantId, deviceId: r.device.id, revokedBy: ownerId }))?.alreadyRevoked).toBe(true);
    expect(await revokeDevice(t.db, { tenantId, deviceId: "00000000-0000-4000-8000-000000000000", revokedBy: null })).toBeUndefined();

    expect(await listDevices(t.db, tenantId)).toEqual([]);
    expect((await getDevice(t.db, tenantId, r.device.id))?.revokedAt).toBeInstanceOf(Date);
    expect(await recordHeartbeat(t.db, { tenantId, deviceId: r.device.id })).toBeUndefined();
    expect(await renameDevice(t.db, tenantId, r.device.id, "New")).toBeUndefined();
  });

  it("refuses a token whose device was revoked by another path", async () => {
    const { ownerId, tenantId } = await household(t);
    const r = await enrolled(t, tenantId, ownerId, ownerId);
    await tenantScoped(t.db, tenantId).update(devices, { revokedAt: new Date() }, eq(devices.id, r.device.id));
    expect(await resolveDesktopToken(t.db, r.token)).toBeNull();
  });

  it("lists, gets and renames devices within the household only", async () => {
    const { ownerId, tenantId } = await household(t);
    const memberId = await addMember(t, tenantId);
    const other = await household(t);
    const a = await enrolled(t, tenantId, memberId, ownerId);
    const b = await enrolled(t, tenantId, ownerId, ownerId);

    expect((await listDevices(t.db, tenantId)).map((d) => d.id)).toEqual([b.device.id, a.device.id]);
    expect((await listDevices(t.db, tenantId, { userId: memberId })).map((d) => d.id)).toEqual([a.device.id]);
    expect(await listDevices(t.db, other.tenantId)).toEqual([]);
    expect(await getDevice(t.db, other.tenantId, a.device.id)).toBeUndefined();

    expect(await renameDevice(t.db, tenantId, a.device.id, "  ")).toBe("invalid");
    expect(await renameDevice(t.db, tenantId, a.device.id, " Grandma's  Chrome ")).toMatchObject({ name: "Grandma's Chrome" });
    expect(await renameDevice(t.db, other.tenantId, a.device.id, "Hijack")).toBeUndefined();
    expect(await revokeDevice(t.db, { tenantId: other.tenantId, deviceId: a.device.id, revokedBy: other.ownerId })).toBeUndefined();
  });

  it("heartbeats, marks offline once, re-arms on heartbeat, and lists stale devices", async () => {
    const { ownerId, tenantId } = await household(t);
    const threeDaysAgo = new Date(Date.now() - 3 * DAY);
    const r = await enrolled(t, tenantId, ownerId, ownerId, threeDaysAgo);
    const now = new Date();

    // Never seen: counts from created_at.
    expect((await listStaleDevices(t.db, new Date(now.getTime() - DEVICE_OFFLINE_AFTER_MS))).map((d) => d.id)).toContain(r.device.id);
    const marked = await markDeviceOfflineAlerted(t.db, tenantId, r.device.id, now);
    expect(marked?.offlineAlertedAt?.getTime()).toBe(now.getTime());
    expect(await markDeviceOfflineAlerted(t.db, tenantId, r.device.id, now)).toBeUndefined();
    expect((await listStaleDevices(t.db, now)).map((d) => d.id)).not.toContain(r.device.id);

    const beat = await recordHeartbeat(t.db, { tenantId, deviceId: r.device.id, clientVersion: " 0.2.0 ", now });
    expect(beat).toMatchObject({ clientVersion: "0.2.0", offlineAlertedAt: null });
    expect(beat!.lastSeenAt?.getTime()).toBe(now.getTime());
    // Fresh heartbeat: not stale, and cannot be marked.
    expect((await listStaleDevices(t.db, new Date(now.getTime() - DEVICE_OFFLINE_AFTER_MS))).map((d) => d.id)).not.toContain(r.device.id);
    expect(await markDeviceOfflineAlerted(t.db, tenantId, r.device.id, now)).toBeUndefined();
    // Later outage alerts again.
    const later = new Date(now.getTime() + DEVICE_OFFLINE_AFTER_MS + 1000);
    expect(await markDeviceOfflineAlerted(t.db, tenantId, r.device.id, later)).toBeDefined();
  });

  it("purges old revoked devices and spent codes", async () => {
    const { ownerId, tenantId } = await household(t);
    const longAgo = new Date(Date.now() - 100 * DAY);
    const r = await enrolled(t, tenantId, ownerId, ownerId, longAgo);
    await revokeDevice(t.db, { tenantId, deviceId: r.device.id, revokedBy: ownerId, now: longAgo });
    const recent = await enrolled(t, tenantId, ownerId, ownerId);
    await revokeDevice(t.db, { tenantId, deviceId: recent.device.id, revokedBy: ownerId });
    await newCode(t, tenantId, ownerId, ownerId, new Date(Date.now() - 40 * DAY)); // expired long ago
    const pending = await newCode(t, tenantId, ownerId, ownerId);

    expect(await purgeOldDevices(t.db)).toBeGreaterThanOrEqual(2); // the old revoked device and the expired code
    expect(await getDevice(t.db, tenantId, r.device.id)).toBeUndefined();
    expect(await getDevice(t.db, tenantId, recent.device.id)).toBeDefined();
    expect((await listPendingEnrollmentCodes(t.db, tenantId)).map((c) => c.id)).toEqual([pending.record.id]);
  });

  it("revokes a leaving member's devices, codes and tokens", async () => {
    const { ownerId, tenantId } = await household(t);
    const memberId = await addMember(t, tenantId);
    const r = await enrolled(t, tenantId, memberId, ownerId);
    const kept = await enrolled(t, tenantId, ownerId, ownerId);
    await newCode(t, tenantId, memberId, ownerId);

    expect((await leaveHousehold(t.db, { tenantId, userId: memberId })).status).toBe("left");
    expect(await resolveDesktopToken(t.db, r.token)).toBeNull();
    expect((await getDevice(t.db, tenantId, r.device.id))?.revokedAt).toBeInstanceOf(Date);
    expect(await listPendingEnrollmentCodes(t.db, tenantId)).toEqual([]);
    expect((await listDevices(t.db, tenantId)).map((d) => d.id)).toEqual([kept.device.id]);
    expect(await resolveDesktopToken(t.db, kept.token)).not.toBeNull();
  });

  it("enrolls a member's own device through device authorization", async () => {
    const { tenantId } = await household(t);
    const memberId = await addMember(t, tenantId, "Sam");
    const approver = { userId: memberId, tenantId, role: "member" as const, email: "sam@example.test", name: "Sam" };

    expect(await createDesktopAuthRequest(t.db, { clientName: "Neo extension", device: { ...DEVICE, platform: "amiga" as "chrome" } })).toEqual({
      error: "invalid_device",
    });
    const started = await createDesktopAuthRequest(t.db, { clientName: "Neo extension", device: DEVICE });
    if ("error" in started) throw new Error(started.error);
    expect((await getDesktopAuthRequest(t.db, started.userCode))?.device).toEqual(DEVICE);
    await decideDesktopAuthRequest(t.db, { userCode: started.userCode, approve: true, approver });

    const redeemed = await redeemDesktopAuthRequest(t.db, started.deviceCode);
    if (redeemed.status !== "approved") throw new Error(redeemed.status);
    expect(redeemed.scopes).toEqual(["device", "signals:write", "url:check"]);
    expect(redeemed.device).toMatchObject({ userId: memberId, enrollment: "self", enrolledBy: memberId, name: DEVICE.name });
    expect(await resolveDesktopToken(t.db, redeemed.token)).toMatchObject({ deviceId: redeemed.device!.id, role: "member" });
    expect(await listDesktopTokens(t.db, memberId)).toEqual([]);

    // Without a device: a full token as before.
    const plain = await createDesktopAuthRequest(t.db, { clientName: "Omarchy bar" });
    if ("error" in plain) throw new Error(plain.error);
    expect((await getDesktopAuthRequest(t.db, plain.userCode))?.device).toBeNull();
    await decideDesktopAuthRequest(t.db, { userCode: plain.userCode, approve: true, approver });
    const full = await redeemDesktopAuthRequest(t.db, plain.deviceCode);
    expect(full).toMatchObject({ status: "approved", scopes: ["full"], device: null });
  });

  it("keeps device rows and codes behind RLS", async () => {
    const { ownerId, tenantId } = await household(t);
    await enrolled(t, tenantId, ownerId, ownerId);
    await newCode(t, tenantId, ownerId, ownerId);
    // No tenant context: nothing visible.
    expect(await t.db.select().from(devices)).toEqual([]);
    expect(await t.db.select().from(deviceEnrollmentCodes)).toEqual([]);
    // Another tenant's context: nothing of this household, even unfiltered.
    const other = await household(t);
    const seen = await tenantScoped(t.db, other.tenantId).transaction((s) => s.tx.select().from(devices).where(eq(devices.tenantId, tenantId)));
    expect(seen).toEqual([]);
    await expect(
      tenantScoped(t.db, other.tenantId).transaction((s) =>
        s.tx.insert(devices).values({ tenantId, userId: ownerId, kind: "desktop_agent", platform: "linux", name: "x", clientVersion: "1", enrollment: "self" }),
      ),
    ).rejects.toThrow();
    const own = await tenantScoped(t.db, tenantId).select(devices, and(eq(devices.userId, ownerId)));
    expect(own).toHaveLength(1);
  });
});

describe("migration 0009_devices on an existing database", () => {
  const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "neo-mig-"));
  const client = new PGlite();
  afterAll(async () => {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("backfills existing desktop tokens to full with no device", async () => {
    cpSync(migrationsFolder, dir, { recursive: true });
    const journalPath = join(dir, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: Array<{ tag: string }> };
    journal.entries = journal.entries.filter((e) => e.tag < "0009");
    writeFileSync(journalPath, JSON.stringify(journal));

    const db = drizzle({ client, schema });
    await migrate(db, { migrationsFolder: dir });
    await client.exec(`
      insert into users (id, name, email) values ('u1', 'U', 'u1@example.test');
      insert into tenants (id, name) values ('11111111-1111-4111-8111-111111111111', 'T');
      insert into desktop_tokens (user_id, tenant_id, role, name, token_hash, token_prefix)
        values ('u1', '11111111-1111-4111-8111-111111111111', 'owner', 'Omarchy bar', 'h', 'p');
    `);
    await migrate(db, { migrationsFolder });
    const rows = await client.query<{ scopes: string[]; device_id: string | null }>("select scopes, device_id from desktop_tokens");
    expect(rows.rows).toEqual([{ scopes: ["full"], device_id: null }]);

    const fns = await client.query<{ proname: string; prosecdef: boolean; config: string[] | null }>(
      `select proname, prosecdef, proconfig as config from pg_proc
       where proname in ('lookup_device_enrollment_code', 'list_stale_devices', 'purge_old_devices') order by proname`,
    );
    expect(fns.rows.map((f) => f.proname)).toEqual(["list_stale_devices", "lookup_device_enrollment_code", "purge_old_devices"]);
    for (const f of fns.rows) {
      expect(f.prosecdef).toBe(true);
      expect(f.config).toEqual(["search_path=pg_catalog, public"]);
    }
  });
});
