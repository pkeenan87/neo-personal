import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvents, usageEvents } from "../src/schema/index.js";
import { tenantScoped } from "../src/tenant.js";
import { createTenantForUser } from "../src/tenants.js";
import { getUsageCaps, parseIntEnv, usage, utcWindows } from "../src/usage.js";
import { createTestDb, createUser, type TestDb } from "./helpers.js";

const NOW = new Date("2026-09-24T15:00:00Z");

describe("parseIntEnv / getUsageCaps", () => {
  it("falls back on missing or invalid values", () => {
    expect(parseIntEnv(undefined, 50)).toBe(50);
    expect(parseIntEnv("", 50)).toBe(50);
    expect(parseIntEnv("abc", 50)).toBe(50);
    expect(parseIntEnv("-3", 50)).toBe(50);
    expect(parseIntEnv("2.5", 50)).toBe(50);
    expect(parseIntEnv("1e9", 50)).toBe(50);
    expect(parseIntEnv(" 20 ", 50)).toBe(20);
    expect(parseIntEnv("300_000", 1)).toBe(300000);
    expect(parseIntEnv("0", 50)).toBe(0);
  });

  it("reads defaults and env overrides", () => {
    expect(getUsageCaps({})).toEqual({ monthlyChecks: 50, dailyTokens: 300000 });
    expect(getUsageCaps({ USAGE_CAP_MONTHLY_CHECKS: "5", USAGE_CAP_DAILY_TOKENS: "nope" })).toEqual({
      monthlyChecks: 5,
      dailyTokens: 300000,
    });
  });

  it("computes UTC month and day windows", () => {
    const w = utcWindows(new Date("2026-12-31T23:59:59Z"));
    expect(w.monthStart.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(w.monthEnd.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(w.dayStart.toISOString()).toBe("2026-12-31T00:00:00.000Z");
    expect(w.dayEnd.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("usage.checkCaps / recordCheck", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t.close();
  });

  async function freshTenant() {
    const userId = await createUser(t.db);
    const { tenantId } = await createTenantForUser(t.db, { userId, name: "h" });
    return { tenantId, userId };
  }

  async function insertAt(tenantId: string, userId: string, createdAt: Date, inputTokens = 0, outputTokens = 0) {
    await tenantScoped(t.db, tenantId).insert(usageEvents, { userId, model: "claude-opus-5", inputTokens, outputTokens, createdAt });
  }

  it("allows the last check under the monthly cap and blocks at the cap", async () => {
    const { tenantId, userId } = await freshTenant();
    const caps = { monthlyChecks: 3, dailyTokens: 1_000_000 };
    await insertAt(tenantId, userId, new Date("2026-09-01T00:00:00Z")); // first instant of the month counts
    await insertAt(tenantId, userId, new Date("2026-08-31T23:59:59Z")); // previous month does not
    await insertAt(tenantId, userId, new Date("2026-09-10T12:00:00Z"));

    const under = await usage.checkCaps(t.db, tenantId, { now: NOW, caps });
    expect(under).toMatchObject({ allowed: true, used: { monthlyChecks: 2 }, remaining: { monthlyChecks: 1 } });

    await insertAt(tenantId, userId, new Date("2026-09-20T12:00:00Z"));
    const at = await usage.checkCaps(t.db, tenantId, { now: NOW, caps });
    expect(at).toMatchObject({ allowed: false, reason: "monthly_checks", remaining: { monthlyChecks: 0 } });
  });

  it("blocks on daily tokens (input + output, UTC day) at the cap", async () => {
    const { tenantId, userId } = await freshTenant();
    const caps = { monthlyChecks: 100, dailyTokens: 1000 };
    await insertAt(tenantId, userId, new Date("2026-09-23T23:59:59Z"), 5000, 5000); // yesterday
    await insertAt(tenantId, userId, new Date("2026-09-24T00:00:00Z"), 600, 399);

    const under = await usage.checkCaps(t.db, tenantId, { now: NOW, caps });
    expect(under).toMatchObject({ allowed: true, used: { dailyTokens: 999 }, remaining: { dailyTokens: 1 } });

    await insertAt(tenantId, userId, new Date("2026-09-24T14:00:00Z"), 1, 0);
    const at = await usage.checkCaps(t.db, tenantId, { now: NOW, caps });
    expect(at).toMatchObject({ allowed: false, reason: "daily_tokens", remaining: { dailyTokens: 0 } });
  });

  it("uses env caps by default and counts recordCheck rows per tenant only", async () => {
    const a = await freshTenant();
    const b = await freshTenant();
    const prev = process.env.USAGE_CAP_MONTHLY_CHECKS;
    process.env.USAGE_CAP_MONTHLY_CHECKS = "2";
    try {
      await usage.recordCheck(t.db, { ...a, model: "claude-opus-5", inputTokens: 10, outputTokens: 5, cacheReadTokens: 7 });
      await usage.recordCheck(t.db, { ...a, model: "claude-opus-5", inputTokens: 10, outputTokens: 5 });
      expect(await usage.checkCaps(t.db, a.tenantId)).toMatchObject({
        allowed: false,
        reason: "monthly_checks",
        limits: { monthlyChecks: 2, dailyTokens: 300000 },
        used: { monthlyChecks: 2, dailyTokens: 30 },
      });
      expect(await usage.checkCaps(t.db, b.tenantId)).toMatchObject({ allowed: true, used: { monthlyChecks: 0 } });
    } finally {
      if (prev === undefined) delete process.env.USAGE_CAP_MONTHLY_CHECKS;
      else process.env.USAGE_CAP_MONTHLY_CHECKS = prev;
    }
  });

  it("counts resume rows toward daily tokens but not monthly checks, and reports resetAt", async () => {
    const { tenantId, userId } = await freshTenant();
    const caps = { monthlyChecks: 1, dailyTokens: 1000 };
    await usage.recordCheck(t.db, { tenantId, userId, model: "claude-opus-5", inputTokens: 100, outputTokens: 50, kind: "resume" });
    const r = await usage.checkCaps(t.db, tenantId, { caps });
    expect(r).toMatchObject({ allowed: true, used: { monthlyChecks: 0, dailyTokens: 150 } });
    const w = utcWindows(new Date());
    expect(r.resetAt).toEqual({ monthlyChecks: w.monthEnd, dailyTokens: w.dayEnd });
  });

  it("writes one usage.cap_hit audit event per tenant, reason and period", async () => {
    const { tenantId, userId } = await freshTenant();
    const base = { tenantId, userId, limit: 2, used: 2, resetAt: new Date("2026-10-01T00:00:00Z"), now: NOW };
    expect(await usage.recordCapHit(t.db, { ...base, reason: "monthly_checks" })).toBe(true);
    expect(await usage.recordCapHit(t.db, { ...base, reason: "monthly_checks" })).toBe(false);
    expect(await usage.recordCapHit(t.db, { ...base, reason: "daily_tokens" })).toBe(true);
    const rows = await tenantScoped(t.db, tenantId).select(auditEvents);
    const hits = rows.filter((r) => r.eventType === "usage.cap_hit");
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.metadata.reason).sort()).toEqual(["daily_tokens", "monthly_checks"]);
  });
});
