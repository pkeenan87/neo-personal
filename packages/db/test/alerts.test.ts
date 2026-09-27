/** Owner alerts on PGlite with the committed migrations, as the non-owner app role. */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acknowledgeAlert,
  acknowledgeAllAlerts,
  countAlertEmailsSince,
  countOpenAlerts,
  createAlert,
  getAlert,
  getAlertEmailThreshold,
  listAlertOwners,
  listAlerts,
  markAlertEmail,
  purgeOldAlerts,
  setAlertEmailThreshold,
} from "../src/alerts.js";
import { memberships } from "../src/schema/index.js";
import { tenantScoped } from "../src/tenant.js";
import { createTenantForUser } from "../src/tenants.js";
import { InvalidCursorError } from "../src/verdicts.js";
import { becomeAppUser, createTestDb, createUser, type TestDb } from "./helpers.js";

describe("alerts", () => {
  let t: TestDb;
  let tenant: string;
  let owner: string;
  let member: string;

  beforeAll(async () => {
    t = await createTestDb();
    await becomeAppUser(t.client);
    owner = await createUser(t.db, "Pat");
    member = await createUser(t.db, "Kid");
    ({ tenantId: tenant } = await createTenantForUser(t.db, { userId: owner, name: "Pat's household" }));
    await tenantScoped(t.db, tenant).insert(memberships, { userId: member, role: "member" });
  });
  afterAll(async () => {
    await t.close();
  });

  function alertInput(dedupeKey: string, over: Partial<Parameters<typeof createAlert>[1]> = {}) {
    return {
      tenantId: tenant,
      subjectUserId: member,
      kind: "member_verdict" as const,
      severity: "high" as const,
      title: "Kid checked something malicious",
      body: "A link: fake PayPal login.",
      dedupeKey,
      ...over,
    };
  }

  it("creates once per dedupe key and clips long text", async () => {
    const a = await createAlert(t.db, alertInput("verdict:1", { title: "x".repeat(300), body: "y".repeat(2000) }));
    expect(a).not.toBeNull();
    expect([...a!.title]).toHaveLength(140);
    expect(a!.title.endsWith("…")).toBe(true);
    expect([...a!.body]).toHaveLength(1000);
    expect(a!.emailStatus).toBe("pending");
    expect(await createAlert(t.db, alertInput("verdict:1"))).toBeNull();
    // The same key in another household is independent.
    const other = await createUser(t.db, "Other");
    const { tenantId: otherTenant } = await createTenantForUser(t.db, { userId: other, name: "Other" });
    expect(await createAlert(t.db, alertInput("verdict:1", { tenantId: otherTenant, subjectUserId: other }))).not.toBeNull();
    expect(await getAlert(t.db, otherTenant, a!.id)).toBeUndefined();
  });

  it("lists newest first with subject names, filters and a keyset cursor", async () => {
    for (let i = 0; i < 3; i++) await createAlert(t.db, alertInput(`list:${i}`, { now: new Date(Date.UTC(2026, 8, 20, 10, i)) }));
    await createAlert(t.db, alertInput("joined", { kind: "member_joined", severity: "high", subjectUserId: owner }));

    const mine = await listAlerts(t.db, tenant, { subjectUserId: member, limit: 2 });
    expect(mine.items).toHaveLength(2);
    expect(mine.items.every((i) => i.subjectUserId === member && i.subjectName === "Kid")).toBe(true);
    const next = await listAlerts(t.db, tenant, { subjectUserId: member, limit: 2, cursor: mine.nextCursor! });
    expect(next.items[0]!.createdAt.getTime()).toBeLessThanOrEqual(mine.items[1]!.createdAt.getTime());
    await expect(listAlerts(t.db, tenant, { cursor: "garbage" })).rejects.toBeInstanceOf(InvalidCursorError);

    const all = await listAlerts(t.db, tenant, { limit: 50 });
    expect(all.items.some((i) => i.subjectUserId === owner)).toBe(true);
    expect(await countOpenAlerts(t.db, tenant, { subjectUserId: member })).toBe(4);
    expect(await countOpenAlerts(t.db, tenant, { severities: ["critical"] })).toBe(0);
  });

  it("acknowledges one or all, idempotently", async () => {
    const a = (await createAlert(t.db, alertInput("ack:1")))!;
    const acked = await acknowledgeAlert(t.db, tenant, a.id, owner);
    expect(acked?.acknowledgedBy).toBe(owner);
    const again = await acknowledgeAlert(t.db, tenant, a.id, member);
    expect(again?.acknowledgedBy).toBe(owner);
    expect(await acknowledgeAlert(t.db, tenant, "not-a-uuid", owner)).toBeUndefined();

    const n = await acknowledgeAllAlerts(t.db, tenant, owner);
    expect(n).toBeGreaterThan(0);
    expect(await countOpenAlerts(t.db, tenant)).toBe(0);
    const open = await listAlerts(t.db, tenant, { status: "open" });
    expect(open.items).toEqual([]);
    const listed = await listAlerts(t.db, tenant, { limit: 1 });
    expect(listed.items[0]!.acknowledgedByName).toBe("Pat");
  });

  it("tracks email status and counts sends for the daily cap", async () => {
    const a = (await createAlert(t.db, alertInput("email:1")))!;
    const b = (await createAlert(t.db, alertInput("email:2")))!;
    const since = new Date(Date.now() - 60_000);
    await markAlertEmail(t.db, tenant, a.id, "sent");
    await markAlertEmail(t.db, tenant, b.id, "skipped");
    expect(await countAlertEmailsSince(t.db, tenant, since)).toBe(1);
    expect((await getAlert(t.db, tenant, a.id))?.emailedAt).toBeInstanceOf(Date);
    expect((await getAlert(t.db, tenant, b.id))?.emailedAt).toBeNull();
  });

  it("stores each owner's threshold (default high)", async () => {
    expect(await listAlertOwners(t.db, tenant)).toEqual([expect.objectContaining({ userId: owner, name: "Pat", threshold: "high" })]);
    expect(await setAlertEmailThreshold(t.db, tenant, owner, "medium")).toBe("medium");
    expect(await getAlertEmailThreshold(t.db, tenant, owner)).toBe("medium");
    expect(await setAlertEmailThreshold(t.db, tenant, "nobody", "off")).toBeUndefined();
    await expect(setAlertEmailThreshold(t.db, tenant, owner, "loud" as never)).rejects.toThrow();
  });

  it("purges old alerts across tenants as the app role", async () => {
    const old = (await createAlert(t.db, alertInput("old:acked", { now: new Date(Date.now() - 100 * 86_400_000) })))!;
    await acknowledgeAlert(t.db, tenant, old.id, owner);
    const oldOpen = (await createAlert(t.db, alertInput("old:open", { now: new Date(Date.now() - 100 * 86_400_000) })))!;
    const ancient = (await createAlert(t.db, alertInput("ancient", { now: new Date(Date.now() - 200 * 86_400_000) })))!;
    const n = await purgeOldAlerts(t.db);
    expect(n).toBe(2);
    expect(await getAlert(t.db, tenant, old.id)).toBeUndefined();
    expect(await getAlert(t.db, tenant, ancient.id)).toBeUndefined();
    expect(await getAlert(t.db, tenant, oldOpen.id)).toBeDefined();
  });

  it("is invisible without the tenant context", async () => {
    const res = await t.db.execute(sql`select count(*)::int as n from alerts`);
    expect((res as unknown as { rows: { n: number }[] }).rows[0]!.n).toBe(0);
  });
});
