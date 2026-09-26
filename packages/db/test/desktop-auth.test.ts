import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/client.js";
import {
  createDesktopAuthRequest,
  decideDesktopAuthRequest,
  generateUserCode,
  getDesktopAuthRequest,
  isDeviceCodeFormat,
  mintDeviceCode,
  normalizeClientName,
  normalizeUserCode,
  redeemDesktopAuthRequest,
  type DesktopAuthApprover,
} from "../src/desktop-auth.js";
import { listDesktopTokens, resolveDesktopToken } from "../src/desktop-tokens.js";
import { createTenantForUser } from "../src/tenants.js";
import { createTestDb, createUser, type TestDb } from "./helpers.js";

describe("desktop auth codes", () => {
  it("generates readable XXXX-XXXX user codes without look-alike characters", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateUserCode();
      expect(code).toMatch(/^[BCDFGHJKMNPQRTWXYZ2346789]{4}-[BCDFGHJKMNPQRTWXYZ2346789]{4}$/);
      expect(normalizeUserCode(code)).toBe(code);
    }
  });

  it("normalizes typed user codes", () => {
    expect(normalizeUserCode(" bcdf 2346 ")).toBe("BCDF-2346");
    expect(normalizeUserCode("bcdf-234")).toBeNull();
    expect(normalizeUserCode("")).toBeNull();
  });

  it("mints device codes in the expected format", () => {
    expect(isDeviceCodeFormat(mintDeviceCode())).toBe(true);
    expect(isDeviceCodeFormat("neo_dt_" + "a".repeat(43))).toBe(false);
    expect(isDeviceCodeFormat("neo_dc_short")).toBe(false);
  });

  it("cleans client names", () => {
    expect(normalizeClientName("  NeoShield\ton  laptop\u0007 ")).toBe("NeoShield on laptop");
    expect(normalizeClientName("\u0001")).toBeNull();
    expect(normalizeClientName("x".repeat(100))).toHaveLength(64);
  });
});

describe("desktop auth flow (PGlite)", () => {
  let t: TestDb;
  let db: Db;
  let approver: DesktopAuthApprover;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    const userId = await createUser(db, "Ada");
    const { tenantId } = await createTenantForUser(db, { userId, name: "Ada's household" });
    approver = { userId, tenantId, role: "owner", email: "ada@example.test", name: "Ada" };
  });
  afterAll(() => t.close());

  it("approve → redeem mints a working desktop token exactly once", async () => {
    const started = await createDesktopAuthRequest(db, { clientName: "NeoShield on laptop" });
    if ("error" in started) throw new Error("unexpected");
    expect(await redeemDesktopAuthRequest(db, started.deviceCode)).toEqual({ status: "pending" });

    const shown = await getDesktopAuthRequest(db, started.userCode.toLowerCase());
    expect(shown).toMatchObject({ clientName: "NeoShield on laptop", status: "pending" });

    expect(await decideDesktopAuthRequest(db, { userCode: started.userCode, approve: true, approver })).toEqual({
      decision: "approved",
      clientName: "NeoShield on laptop",
    });
    expect((await decideDesktopAuthRequest(db, { userCode: started.userCode, approve: false, approver })).decision).toBe("already_decided");

    const redeemed = await redeemDesktopAuthRequest(db, started.deviceCode);
    expect(redeemed.status).toBe("approved");
    if (redeemed.status !== "approved") throw new Error("unexpected");
    expect(redeemed.email).toBe("ada@example.test");
    expect(redeemed.record.name).toBe("NeoShield on laptop");
    expect(await resolveDesktopToken(db, redeemed.token)).toMatchObject({ userId: approver.userId, tenantId: approver.tenantId, role: "owner" });
    expect(await listDesktopTokens(db, approver.userId)).toHaveLength(1);

    // One-shot: the row is gone, the device code is dead.
    expect(await redeemDesktopAuthRequest(db, started.deviceCode)).toEqual({ status: "not_found" });
    expect(await getDesktopAuthRequest(db, started.userCode)).toBeNull();
  });

  it("deny is reported once and never mints", async () => {
    const started = await createDesktopAuthRequest(db, { clientName: "Other" });
    if ("error" in started) throw new Error("unexpected");
    expect((await decideDesktopAuthRequest(db, { userCode: started.userCode, approve: false, approver })).decision).toBe("denied");
    expect(await redeemDesktopAuthRequest(db, started.deviceCode)).toEqual({ status: "denied" });
    expect(await redeemDesktopAuthRequest(db, started.deviceCode)).toEqual({ status: "not_found" });
    expect(await listDesktopTokens(db, approver.userId)).toHaveLength(1);
  });

  it("expired requests cannot be approved or redeemed", async () => {
    const past = new Date(Date.now() - 20 * 60 * 1000);
    const started = await createDesktopAuthRequest(db, { clientName: "Old", now: past });
    if ("error" in started) throw new Error("unexpected");
    expect(await getDesktopAuthRequest(db, started.userCode)).toBeNull();
    expect((await decideDesktopAuthRequest(db, { userCode: started.userCode, approve: true, approver })).decision).toBe("not_found");
    expect(await redeemDesktopAuthRequest(db, started.deviceCode)).toEqual({ status: "expired" });
  });

  it("rejects unknown codes and bad names", async () => {
    expect(await redeemDesktopAuthRequest(db, mintDeviceCode())).toEqual({ status: "not_found" });
    expect(await redeemDesktopAuthRequest(db, "garbage")).toEqual({ status: "not_found" });
    expect((await decideDesktopAuthRequest(db, { userCode: "ZZZZ-ZZZZ", approve: true, approver })).decision).toBe("not_found");
    expect(await createDesktopAuthRequest(db, { clientName: "   " })).toEqual({ error: "bad_name" });
  });
});
