import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALERT_KINDS } from "../src/schema/alerts.js";
import { usageEvents } from "../src/schema/index.js";
import { spend } from "../src/spend.js";
import { tenantScoped } from "../src/tenant.js";
import { createTenantForUser, setHouseholdTimeZone } from "../src/tenants.js";
import { becomeAppUser, createTestDb, createUser, type TestDb } from "./helpers.js";

let t: TestDb;
let tenantA: string;
let tenantB: string;
const MODEL = "anthropic/claude-opus-5"; // $25 per million output tokens: 100,000 output tokens = 250 cents

beforeAll(async () => {
  t = await createTestDb({ createAppUserBeforeMigrations: true });
  tenantA = (await createTenantForUser(t.db, { userId: await createUser(t.db, "A"), name: "A" })).tenantId;
  tenantB = (await createTenantForUser(t.db, { userId: await createUser(t.db, "B"), name: "B" })).tenantId;
  await becomeAppUser(t.client);
}, 60_000);
afterAll(async () => {
  await t?.close();
});

async function record(tenantId: string, at: Date, outputTokens: number) {
  await tenantScoped(t.db, tenantId).insert(usageEvents, {
    userId: await createUser(t.db, "u"),
    kind: "check",
    model: MODEL,
    inputTokens: 0,
    outputTokens,
    createdAt: at,
  });
}

describe("migration 0027_spend_cap", () => {
  it("adds a nullable cap that is null by default", async () => {
    expect(await spend.getSpendSettings(t.db, tenantA)).toEqual({ capCents: null, timeZone: null });
  });

  it("enforces 100 to 1,000,000 cents when set", async () => {
    for (const bad of [99, 1_000_001, -5]) {
      await expect(
        tenantScoped(t.db, tenantA).transaction(({ tx }) => tx.execute(sql`update tenants set monthly_spend_cap_cents = ${bad} where id = ${tenantA}::uuid`)),
      ).rejects.toThrow();
    }
    expect(await spend.setSpendCap(t.db, tenantA, 100)).toBe(true);
    expect(await spend.setSpendCap(t.db, tenantA, 1_000_000)).toBe(true);
    await expect(spend.setSpendCap(t.db, tenantA, 99)).rejects.toThrow(/invalid spend cap/);
    expect(await spend.setSpendCap(t.db, tenantA, null)).toBe(true);
    expect((await spend.getSpendSettings(t.db, tenantA))?.capCents).toBeNull();
  });

  it("keeps every existing alert kind and accepts spend_cap, and still rejects unknown kinds", async () => {
    expect(ALERT_KINDS).toContain("spend_cap");
    for (const kind of ALERT_KINDS) {
      await tenantScoped(t.db, tenantA).transaction(({ tx }) =>
        tx.execute(sql`insert into alerts (tenant_id, kind, severity, title, body, dedupe_key) values (${tenantA}::uuid, ${kind}, 'low', 't', 'b', ${`kind-test:${kind}`})`),
      );
    }
    await expect(
      tenantScoped(t.db, tenantA).transaction(({ tx }) =>
        tx.execute(sql`insert into alerts (tenant_id, kind, severity, title, body, dedupe_key) values (${tenantA}::uuid, 'nope', 'low', 't', 'b', 'kind-test:nope')`),
      ),
    ).rejects.toThrow();
  });

  it("dedupes the 80% and 100% alerts on (tenant, dedupe_key)", async () => {
    // Rows inserted per attempt (0 when the dedupe key already exists).
    const insert = async (key: string): Promise<number> => {
      const res = (await tenantScoped(t.db, tenantB).transaction(({ tx }) =>
        tx.execute(sql`insert into alerts (tenant_id, kind, severity, title, body, dedupe_key) values (${tenantB}::uuid, 'spend_cap', 'medium', 't', 'b', ${key}) on conflict do nothing returning id`),
      )) as unknown as { rows: unknown[] };
      return res.rows.length;
    };
    const key = `spend_cap:${tenantB}:2026-11:80`;
    expect(await insert(key)).toBe(1);
    expect(await insert(key)).toBe(0);
    expect(await insert(`spend_cap:${tenantB}:2026-11:100`)).toBe(1);
  });
});

describe("month-to-date spend", () => {
  it("prices usage by model and sums only the tenant's own month", async () => {
    await record(tenantA, new Date("2026-11-10T12:00:00Z"), 100_000);
    await record(tenantA, new Date("2026-11-11T12:00:00Z"), 100_000);
    await record(tenantA, new Date("2026-10-10T12:00:00Z"), 100_000); // last month
    await record(tenantB, new Date("2026-11-10T12:00:00Z"), 400_000); // another household
    const status = await spend.spendStatus(t.db, tenantA, new Date("2026-11-20T00:00:00Z"));
    expect(status?.spentCents).toBeCloseTo(500, 6);
    expect(status?.capCents).toBeNull();
    expect(status?.percent).toBeNull();
    expect(status?.level).toBe("ok");
  });

  it("reports percent and level against the cap", async () => {
    await spend.setSpendCap(t.db, tenantA, 625);
    const status = await spend.spendStatus(t.db, tenantA, new Date("2026-11-20T00:00:00Z"));
    expect(status?.percent).toBeCloseTo(80, 6);
    expect(status?.level).toBe("warn");
    await spend.setSpendCap(t.db, tenantA, 500);
    expect((await spend.spendStatus(t.db, tenantA, new Date("2026-11-20T00:00:00Z")))?.level).toBe("blocked");
  });

  it("rolls the month over in the household time zone", async () => {
    const inst = new Date("2026-10-31T20:00:00Z"); // 2026-11-01 09:00 in Auckland, still October in UTC
    await record(tenantA, inst, 200_000);
    const utc = await spend.spendStatus(t.db, tenantA, new Date("2026-10-31T21:00:00Z"));
    expect(utc?.window.month).toBe("2026-10");
    expect(utc?.spentCents).toBeCloseTo(250 + 500, 6); // Oct 10 and the 20:00Z row
    await setHouseholdTimeZone(t.db, tenantA, "Pacific/Auckland");
    const nz = await spend.spendStatus(t.db, tenantA, new Date("2026-10-31T21:00:00Z"));
    expect(nz?.window.month).toBe("2026-11");
    expect(nz?.window.start.toISOString()).toBe("2026-10-31T11:00:00.000Z");
    // November in Auckland starts 2026-10-31T11:00Z: the 20:00Z row and the two November rows count, October's 10th does not.
    expect(nz?.spentCents).toBeCloseTo(500 + 250 + 250, 6);
  });

  it("returns undefined for an unknown tenant", async () => {
    expect(await spend.spendStatus(t.db, "00000000-0000-4000-8000-000000000999")).toBeUndefined();
  });
});
