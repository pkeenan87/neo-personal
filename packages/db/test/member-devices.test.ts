/**
 * Member-only devices (_specs/v2-m2-child.md section 2) on PGlite as the non-owner app role (RLS and the
 * security-definer triggers are exercised): a member without an account is enrolled by code, its device
 * token has no user and no role, its signals and alerts are keyed by member, and removing a member never
 * leaves an active device behind.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { countOpenAlerts, createAlert, listAlerts } from "../src/alerts.js";
import { insertDeviceToken, resolveDesktopToken } from "../src/desktop-tokens.js";
import {
  createEnrollmentCode,
  getDevice,
  listDevices,
  listPendingEnrollmentCodes,
  previewEnrollmentCode,
  redeemEnrollmentCode,
  revokeDevice,
  type DeviceInput,
} from "../src/devices.js";
import { leaveHousehold } from "../src/household.js";
import { deleteMemberForUser, getProtectionLayers } from "../src/members.js";
import { insertDeviceSignal, listRecentMemberSignals, listRecentUserSignals } from "../src/signals.js";
import { deviceEnrollmentCodes, desktopTokens, devices, deviceSignals, members, memberships } from "../src/schema/index.js";
import { tenantScoped } from "../src/tenant.js";
import { createTenantForUser, getHouseholdTimeZone, normalizeTimeZone, setHouseholdTimeZone } from "../src/tenants.js";
import { becomeAppUser, createTestDb, createUser, type TestDb } from "./helpers.js";

const DEVICE: DeviceInput = { kind: "browser_extension", platform: "chrome", name: "Chrome on Gran's PC", clientVersion: "1.0.0" };

let t: TestDb;
let ownerId: string;
let tenantId: string;
let ownerMemberId: string;
let gran: string; // a member without an account
let otherTenantId: string;

beforeAll(async () => {
  t = await createTestDb({ createAppUserBeforeMigrations: true });
  ownerId = await createUser(t.db, "Pat");
  tenantId = (await createTenantForUser(t.db, { userId: ownerId, name: "Pat's household" })).tenantId;
  const other = await createUser(t.db, "Zed");
  otherTenantId = (await createTenantForUser(t.db, { userId: other, name: "Zed's household" })).tenantId;
  await becomeAppUser(t.client);
  const scoped = tenantScoped(t.db, tenantId);
  [ownerMemberId] = (await scoped.select(members, eq(members.userId, ownerId))).map((m) => m.id) as [string];
  const [row] = await scoped.insert(members, { userId: null, displayName: "Gran", role: "elder", mode: "elder" });
  gran = row!.id;
}, 60_000);
afterAll(async () => {
  await t?.close();
});

async function enrollGran() {
  const made = await createEnrollmentCode(t.db, { tenantId, memberId: gran, createdBy: ownerId });
  if ("error" in made) throw new Error(made.error);
  const r = await redeemEnrollmentCode(t.db, { code: made.code, device: DEVICE });
  if (r.status !== "enrolled") throw new Error(r.status);
  return { made, r };
}

describe("enrollment codes for a member", () => {
  it("mints a code for a member without an account and previews and redeems it", async () => {
    const made = await createEnrollmentCode(t.db, { tenantId, memberId: gran, createdBy: ownerId });
    if ("error" in made) throw new Error(made.error);
    expect(made.record).toMatchObject({ userId: null, memberId: gran, memberName: "Gran", createdBy: ownerId });
    expect(await listPendingEnrollmentCodes(t.db, tenantId)).toEqual([expect.objectContaining({ id: made.record.id, userId: null, memberId: gran, memberName: "Gran" })]);

    expect(await previewEnrollmentCode(t.db, { code: made.code })).toMatchObject({ memberName: "Gran", ownerName: "Pat" });
    const r = await redeemEnrollmentCode(t.db, { code: made.code, device: DEVICE });
    if (r.status !== "enrolled") throw new Error(r.status);
    expect(r.device).toMatchObject({ userId: null, memberId: gran, memberName: "Gran", enrollment: "code", enrolledBy: ownerId });
    expect(r.memberName).toBe("Gran");
    // Single use.
    expect((await redeemEnrollmentCode(t.db, { code: made.code, device: DEVICE })).status).toBe("not_found");
    expect(await previewEnrollmentCode(t.db, { code: made.code })).toBeNull();
    const [row] = await tenantScoped(t.db, tenantId).select(deviceEnrollmentCodes, eq(deviceEnrollmentCodes.id, made.record.id));
    expect(row).toMatchObject({ userId: null, memberId: gran, deviceId: r.device.id });
  });

  it("mints a code by member id for an account holder too, and records their user", async () => {
    const made = await createEnrollmentCode(t.db, { tenantId, memberId: ownerMemberId, createdBy: ownerId });
    if ("error" in made) throw new Error(made.error);
    expect(made.record).toMatchObject({ userId: ownerId, memberId: ownerMemberId, memberName: "Pat" });
    const r = await redeemEnrollmentCode(t.db, { code: made.code, device: DEVICE });
    if (r.status !== "enrolled") throw new Error(r.status);
    expect(r.device).toMatchObject({ userId: ownerId, memberId: ownerMemberId });
    expect(await resolveDesktopToken(t.db, r.token)).toMatchObject({ userId: ownerId, role: "owner", memberId: ownerMemberId });
  });

  it("rejects another household's member, an unknown id and a malformed id", async () => {
    const [foreign] = await tenantScoped(t.db, otherTenantId).insert(members, { userId: null, displayName: "Zed's gran", role: "elder" });
    expect(await createEnrollmentCode(t.db, { tenantId, memberId: foreign!.id, createdBy: ownerId })).toEqual({ error: "not_member" });
    expect(await createEnrollmentCode(t.db, { tenantId, memberId: crypto.randomUUID(), createdBy: ownerId })).toEqual({ error: "not_member" });
    expect(await createEnrollmentCode(t.db, { tenantId, memberId: "nope", createdBy: ownerId })).toEqual({ error: "not_member" });
  });
});

describe("a device token with no user", () => {
  it("resolves with no user and no role, and the member comes from the device", async () => {
    const { r } = await enrollGran();
    const [row] = await t.db.select().from(desktopTokens).where(eq(desktopTokens.id, r.tokenId));
    expect(row).toMatchObject({ userId: null, role: null, memberId: gran, deviceId: r.device.id });
    expect(await resolveDesktopToken(t.db, r.token)).toMatchObject({
      userId: null,
      role: null,
      memberId: gran,
      deviceId: r.device.id,
      scopes: ["device", "signals:write", "url:check"],
    });
    // Revoking the device ends the token.
    await revokeDevice(t.db, { tenantId, deviceId: r.device.id, revokedBy: ownerId });
    expect(await resolveDesktopToken(t.db, r.token)).toBeNull();
  });

  it("insertDeviceToken refuses a full scope and the database refuses a token without a subject", async () => {
    const { r } = await enrollGran();
    await expect(
      insertDeviceToken(t.db, { userId: null, tenantId, role: null, memberId: gran, name: "x", deviceId: r.device.id, scopes: ["full"] }),
    ).rejects.toThrow(/full scope/);
    // A full token has to belong to a user with a role.
    await expect(
      t.db.insert(desktopTokens).values({ userId: null, tenantId, role: null, name: "x", tokenHash: "h-1", tokenPrefix: "pfx00001", scopes: ["full"] }),
    ).rejects.toThrow();
    // A monitoring token has to have a device (the existing scope check) and, while live, a member.
    await expect(
      t.db.insert(desktopTokens).values({ userId: null, tenantId, role: null, name: "x", tokenHash: "h-2", tokenPrefix: "pfx00002", scopes: ["device"] }),
    ).rejects.toThrow();
  });
});

describe("signals and alerts keyed by member", () => {
  it("stores each signal with its device's member and reads them back by member", async () => {
    const { r } = await enrollGran();
    const at = new Date();
    const a = await insertDeviceSignal(t.db, { tenantId, deviceId: r.device.id, memberId: gran, userId: null, clientEventId: crypto.randomUUID(), type: "web", detector: "scam_page", subject: "a.example", payload: {}, observedAt: at });
    // A writer that omits the member gets the device's.
    const b = await insertDeviceSignal(t.db, { tenantId, deviceId: r.device.id, userId: null, clientEventId: crypto.randomUUID(), type: "web", detector: "scam_page", subject: "b.example", payload: {}, observedAt: new Date(at.getTime() + 1) });
    expect([a.row.memberId, b.row.memberId]).toEqual([gran, gran]);
    expect(a.row.userId).toBeNull();

    const since = new Date(at.getTime() - 60_000);
    const recent = await listRecentMemberSignals(t.db, tenantId, gran, { since });
    expect(recent.map((s) => s.subject)).toEqual(["a.example", "b.example"]);
    expect(await listRecentMemberSignals(t.db, otherTenantId, gran, { since })).toEqual([]);
    // The owner's signals are a different member's.
    expect(await listRecentMemberSignals(t.db, tenantId, ownerMemberId, { since })).toEqual([]);
    expect(await listRecentUserSignals(t.db, tenantId, ownerId, { since })).toEqual([]);
  });

  it("finds an account holder's signals by member through the user-keyed reader", async () => {
    const r = await redeemEnrollmentCode(t.db, {
      code: ((await createEnrollmentCode(t.db, { tenantId, userId: ownerId, createdBy: ownerId })) as { code: string }).code,
      device: DEVICE,
    });
    if (r.status !== "enrolled") throw new Error(r.status);
    await insertDeviceSignal(t.db, { tenantId, deviceId: r.device.id, userId: ownerId, clientEventId: crypto.randomUUID(), type: "web", detector: "scam_page", subject: "own.example", payload: {}, observedAt: new Date() });
    const rows = await listRecentUserSignals(t.db, tenantId, ownerId, { since: new Date(Date.now() - 60_000) });
    expect(rows.map((s) => s.subject)).toEqual(["own.example"]);
    expect(rows[0]).toMatchObject({ memberId: ownerMemberId, userId: ownerId });
  });

  it("lists devices and alerts by member, and an account's own view by user", async () => {
    const { r } = await enrollGran();
    expect((await listDevices(t.db, tenantId, { memberId: gran })).map((d) => d.id)).toContain(r.device.id);
    expect((await listDevices(t.db, tenantId, { memberId: ownerMemberId })).map((d) => d.id)).not.toContain(r.device.id);
    expect((await listDevices(t.db, tenantId, { userId: ownerId })).every((d) => d.memberId === ownerMemberId)).toBe(true);

    await createAlert(t.db, { tenantId, subjectUserId: null, memberId: gran, kind: "scam_page", severity: "high", title: "Gran opened a scam page", body: "b", dedupeKey: "m-gran-1", deviceId: r.device.id });
    await createAlert(t.db, { tenantId, subjectUserId: ownerId, kind: "scam_page", severity: "high", title: "Pat opened a scam page", body: "b", dedupeKey: "m-pat-1" });
    const hers = await listAlerts(t.db, tenantId, { memberId: gran });
    expect(hers.items.map((a) => a.title)).toEqual(["Gran opened a scam page"]);
    expect(hers.items[0]).toMatchObject({ subjectUserId: null, memberId: gran, subjectName: "Gran" });
    expect((await listAlerts(t.db, tenantId, { aboutUserId: ownerId })).items.map((a) => a.title)).toEqual(["Pat opened a scam page"]);
    expect(await countOpenAlerts(t.db, tenantId, { aboutUserId: ownerId })).toBe(1);
    expect(await countOpenAlerts(t.db, tenantId, { memberId: gran })).toBe(1);
    // Both id forms of one member agree: the alert is found by the member behind the account too.
    expect((await listAlerts(t.db, tenantId, { memberId: ownerMemberId })).items.map((a) => a.title)).toEqual(["Pat opened a scam page"]);
  });

  it("loads the policy layers straight from the member, with or without an account", async () => {
    const layers = await getProtectionLayers(tenantScoped(t.db, tenantId), { memberId: gran });
    expect(layers).toMatchObject({ memberId: gran, mode: "elder" });
    expect(await getProtectionLayers(tenantScoped(t.db, tenantId), { memberId: "nope" })).toEqual({ memberId: null, mode: "standard" });
    expect(await getProtectionLayers(tenantScoped(t.db, otherTenantId), { memberId: gran })).toEqual({ memberId: null, mode: "standard" });
  });
});

describe("removing a member never leaves an active device behind", () => {
  it("revokes a deleted member's live devices, codes and tokens, and keeps their rows", async () => {
    const [kid] = await tenantScoped(t.db, tenantId).insert(members, { userId: null, displayName: "Kid", role: "child" });
    const made = await createEnrollmentCode(t.db, { tenantId, memberId: kid!.id, createdBy: ownerId });
    if ("error" in made) throw new Error(made.error);
    const r = await redeemEnrollmentCode(t.db, { code: made.code, device: DEVICE });
    if (r.status !== "enrolled") throw new Error(r.status);
    await insertDeviceSignal(t.db, { tenantId, deviceId: r.device.id, userId: null, clientEventId: crypto.randomUUID(), type: "web", detector: "scam_page", subject: "k.example", payload: {}, observedAt: new Date() });
    const pending = await createEnrollmentCode(t.db, { tenantId, memberId: kid!.id, createdBy: ownerId });
    if ("error" in pending) throw new Error(pending.error);

    await tenantScoped(t.db, tenantId).transaction(async (s) => {
      const { revokeMemberDevicesTx } = await import("../src/members.js");
      await revokeMemberDevicesTx(s.tx, tenantId, kid!.id, new Date());
      await s.delete(members, eq(members.id, kid!.id));
    });
    const device = await getDevice(t.db, tenantId, r.device.id);
    expect(device).toMatchObject({ memberId: null });
    expect(device?.revokedAt).toBeInstanceOf(Date);
    expect(await resolveDesktopToken(t.db, r.token)).toBeNull();
    expect(await previewEnrollmentCode(t.db, { code: pending.code })).toBeNull();
    // Her telemetry goes with her.
    expect(await tenantScoped(t.db, tenantId).select(deviceSignals, eq(deviceSignals.deviceId, r.device.id))).toEqual([]);
  });

  it("refuses a bare delete of a member who still has an active device or a pending code", async () => {
    const [temp] = await tenantScoped(t.db, tenantId).insert(members, { userId: null, displayName: "Temp2", role: "child" });
    const made = await createEnrollmentCode(t.db, { tenantId, memberId: temp!.id, createdBy: ownerId });
    if ("error" in made) throw new Error(made.error);
    // A pending code needs a member (device_enrollment_codes_member_check).
    const refusal = async () => {
      try {
        await tenantScoped(t.db, tenantId).delete(members, eq(members.id, temp!.id));
      } catch (err) {
        return String((err as { cause?: { message?: string } }).cause?.message ?? err);
      }
      return "deleted";
    };
    expect(await refusal()).toMatch(/device_enrollment_codes_member_check/);
    const r = await redeemEnrollmentCode(t.db, { code: made.code, device: DEVICE });
    if (r.status !== "enrolled") throw new Error(r.status);
    // The code is spent, but the active device and its token still need their member.
    expect(await refusal()).toMatch(/devices_member_check|desktop_tokens_subject_check/);
    expect(await getDevice(t.db, tenantId, r.device.id)).toMatchObject({ memberId: temp!.id, revokedAt: null });
    expect(await resolveDesktopToken(t.db, r.token)).toMatchObject({ memberId: temp!.id });
  });

  it("deleteMemberForUser and leaveHousehold revoke an account holder's devices first", async () => {
    const userId = await createUser(t.db, "Leaver");
    await tenantScoped(t.db, tenantId).insert(memberships, { userId, role: "member" });
    const made = await createEnrollmentCode(t.db, { tenantId, userId, createdBy: ownerId });
    if ("error" in made) throw new Error(made.error);
    // The membership had no members row (an older fixture shape): redeeming creates it.
    const r = await redeemEnrollmentCode(t.db, { code: made.code, device: DEVICE });
    if (r.status !== "enrolled") throw new Error(r.status);
    expect(r.device.memberId).not.toBeNull();
    expect((await leaveHousehold(t.db, { tenantId, userId })).status).toBe("left");
    expect(await resolveDesktopToken(t.db, r.token)).toBeNull();
    expect((await getDevice(t.db, tenantId, r.device.id))?.revokedAt).toBeInstanceOf(Date);

    const second = await createUser(t.db, "Direct");
    await tenantScoped(t.db, tenantId).insert(memberships, { userId: second, role: "member" });
    const code2 = await createEnrollmentCode(t.db, { tenantId, userId: second, createdBy: ownerId });
    if ("error" in code2) throw new Error(code2.error);
    const r2 = await redeemEnrollmentCode(t.db, { code: code2.code, device: DEVICE });
    if (r2.status !== "enrolled") throw new Error(r2.status);
    expect(await deleteMemberForUser(tenantScoped(t.db, tenantId), second)).toBe(true);
    expect((await getDevice(t.db, tenantId, r2.device.id))?.revokedAt).toBeInstanceOf(Date);
    expect(await resolveDesktopToken(t.db, r2.token)).toBeNull();
    expect((await tenantScoped(t.db, tenantId).select(devices, eq(devices.id, r2.device.id)))[0]).toMatchObject({ userId: second, memberId: null });
  });
});

describe("household time zone", () => {
  it("validates IANA names and stores the canonical one; null clears it", async () => {
    expect(await getHouseholdTimeZone(t.db, tenantId)).toBeNull();
    expect(normalizeTimeZone("Europe/London")).toBe("Europe/London");
    expect(normalizeTimeZone(" UTC ")).toBe("UTC");
    for (const bad of ["", "Mars/Olympus", "Europe/London; drop table", "x".repeat(65), 5, null, undefined]) expect(normalizeTimeZone(bad)).toBeNull();

    expect(await setHouseholdTimeZone(t.db, tenantId, "America/New_York")).toBe(true);
    expect(await getHouseholdTimeZone(t.db, tenantId)).toBe("America/New_York");
    await expect(setHouseholdTimeZone(t.db, tenantId, "Mars/Olympus")).rejects.toThrow(/invalid time zone/);
    expect(await getHouseholdTimeZone(t.db, tenantId)).toBe("America/New_York");
    // Another household is untouched.
    expect(await getHouseholdTimeZone(t.db, otherTenantId)).toBeNull();
    expect(await setHouseholdTimeZone(t.db, tenantId, null)).toBe(true);
    expect(await getHouseholdTimeZone(t.db, tenantId)).toBeNull();
    await expect(setHouseholdTimeZone(t.db, "not-a-tenant", "UTC")).rejects.toThrow();
  });
});
