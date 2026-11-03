/** eve session ownership on PGlite with the committed migrations, as the non-owner app role (RLS applies). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEveSessionOwner, isEveSessionId, recordEveSession } from "../src/eve-sessions.js";
import { createTenantForUser } from "../src/tenants.js";
import { becomeAppUser, createTestDb, createUser, type TestDb } from "./helpers.js";

describe("eve session ownership", () => {
  let t: TestDb;
  let a: { tenantId: string; userId: string };
  let b: { tenantId: string; userId: string };

  beforeAll(async () => {
    t = await createTestDb();
    await becomeAppUser(t.client);
    const ua = await createUser(t.db, "Ann");
    const ub = await createUser(t.db, "Bob");
    a = { userId: ua, ...(await createTenantForUser(t.db, { userId: ua, name: "A" })) };
    b = { userId: ub, ...(await createTenantForUser(t.db, { userId: ub, name: "B" })) };
  });
  afterAll(async () => {
    await t.close();
  });

  it("records the creator and reads it back in the same household only", async () => {
    await recordEveSession(t.db, { ...a, sessionId: "wrun_A1" });
    expect(await getEveSessionOwner(t.db, a.tenantId, "wrun_A1")).toBe(a.userId);
    expect(await getEveSessionOwner(t.db, b.tenantId, "wrun_A1")).toBeUndefined();
    expect(await getEveSessionOwner(t.db, a.tenantId, "wrun_unknown")).toBeUndefined();
  });

  it("keeps the first owner when a record repeats", async () => {
    await recordEveSession(t.db, { ...a, sessionId: "wrun_A2" });
    await recordEveSession(t.db, { ...a, userId: b.userId, sessionId: "wrun_A2" }).catch(() => {});
    expect(await getEveSessionOwner(t.db, a.tenantId, "wrun_A2")).toBe(a.userId);
  });

  it("rejects malformed ids", async () => {
    expect(isEveSessionId("wrun_01M6")).toBe(true);
    expect(isEveSessionId("has space")).toBe(false);
    expect(isEveSessionId("")).toBe(false);
    await expect(recordEveSession(t.db, { ...a, sessionId: "bad id" })).rejects.toThrow();
    expect(await getEveSessionOwner(t.db, a.tenantId, "bad id")).toBeUndefined();
  });
});
