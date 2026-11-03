/** resolveAlert, incident_actions and the owner/policy reads behind the console, on PGlite as the non-owner app role. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acknowledgeAlert, createAlert, getAlert, resolveAlert } from "../src/alerts.js";
import { listIncidentActions, recordIncidentAction } from "../src/incident-actions.js";
import { countHouseholdOwners, createMemberForUser, getMembershipRole, insertPolicyVersion, latestMemberRules } from "../src/members.js";
import { memberships } from "../src/schema/index.js";
import { tenantScoped } from "../src/tenant.js";
import { createTenantForUser } from "../src/tenants.js";
import { becomeAppUser, createTestDb, createUser, type TestDb } from "./helpers.js";

describe("incident actions", () => {
  let t: TestDb;
  let tenant: string;
  let other: string;
  let owner: string;
  let kid: string;

  beforeAll(async () => {
    t = await createTestDb();
    await becomeAppUser(t.client);
    owner = await createUser(t.db, "Pat");
    kid = await createUser(t.db, "Kid");
    const zed = await createUser(t.db, "Zed");
    ({ tenantId: tenant } = await createTenantForUser(t.db, { userId: owner, name: "Pat's household" }));
    ({ tenantId: other } = await createTenantForUser(t.db, { userId: zed, name: "Zed's household" }));
    await tenantScoped(t.db, tenant).insert(memberships, { userId: kid, role: "member" });
  });
  afterAll(async () => {
    await t.close();
  });

  const input = (dedupeKey: string, tenantId = tenant) => ({
    tenantId,
    subjectUserId: kid,
    kind: "remote_access" as const,
    severity: "critical" as const,
    title: "Remote session",
    body: "Someone connected.",
    dedupeKey,
  });

  it("resolveAlert closes an open alert once, acknowledges it, and refuses a second close", async () => {
    const a = (await createAlert(t.db, input("r-1")))!;
    const at = new Date("2026-11-02T12:00:00Z");
    const closed = await resolveAlert(t.db, tenant, a.id, "false_positive", owner, at);
    expect(closed).toMatchObject({ status: "false_positive", acknowledgedBy: owner });
    expect(closed?.resolvedAt?.getTime()).toBe(at.getTime());
    expect(closed?.acknowledgedAt?.getTime()).toBe(at.getTime());
    expect(await resolveAlert(t.db, tenant, a.id, "resolved", owner)).toBeUndefined();
    expect((await getAlert(t.db, tenant, a.id))?.status).toBe("false_positive");
  });

  it("keeps an earlier acknowledgement and closes an acknowledged alert", async () => {
    const a = (await createAlert(t.db, input("r-2")))!;
    const seen = await acknowledgeAlert(t.db, tenant, a.id, kid, new Date("2026-11-02T10:00:00Z"));
    expect(seen?.status).toBe("acknowledged");
    const closed = await resolveAlert(t.db, tenant, a.id, "resolved", owner, new Date("2026-11-02T11:00:00Z"));
    expect(closed).toMatchObject({ status: "resolved", acknowledgedBy: kid });
    expect(closed?.acknowledgedAt?.toISOString()).toBe("2026-11-02T10:00:00.000Z");
  });

  it("is tenant-scoped and ignores malformed ids", async () => {
    const a = (await createAlert(t.db, input("r-3")))!;
    expect(await resolveAlert(t.db, other, a.id, "resolved", owner)).toBeUndefined();
    expect(await resolveAlert(t.db, tenant, "not-a-uuid", "resolved", owner)).toBeUndefined();
    expect((await getAlert(t.db, tenant, a.id))?.status).toBe("open");
  });

  it("records and lists incident actions per household", async () => {
    const a = (await createAlert(t.db, input("r-4")))!;
    const row = await recordIncidentAction(t.db, tenant, { alertId: a.id, kind: "allow_once", requestedBy: "agent", approvedBy: owner, status: "done", result: { note: "ok" } });
    expect(row).toMatchObject({ tenantId: tenant, alertId: a.id, kind: "allow_once", requestedBy: "agent", approvedBy: owner, status: "done", result: { note: "ok" } });
    expect(await listIncidentActions(t.db, tenant, a.id)).toHaveLength(1);
    expect(await listIncidentActions(t.db, other, a.id)).toHaveLength(0);
    // The foreign household cannot attach an action to this alert.
    await expect(recordIncidentAction(t.db, other, { alertId: a.id, kind: "allow_once", requestedBy: "agent", approvedBy: null, status: "done" })).rejects.toThrow();
  });

  it("reads the membership role and owner count from memberships, and the latest member rules", async () => {
    const tdb = tenantScoped(t.db, tenant);
    expect(await getMembershipRole(tdb, owner)).toBe("owner");
    expect(await getMembershipRole(tdb, kid)).toBe("member");
    expect(await getMembershipRole(tdb, "nobody")).toBeUndefined();
    expect(await getMembershipRole(tenantScoped(t.db, other), owner)).toBeUndefined();
    expect(await countHouseholdOwners(tdb)).toBe(1);

    const m = await createMemberForUser(tdb, { userId: kid, role: "adult", displayName: "Kid" });
    expect(await latestMemberRules(tdb, m.id)).toBeUndefined();
    await insertPolicyVersion(tdb, { scope: "member", scopeId: m.id, rules: { notify: { helpersNotifyAt: "low" } } });
    await insertPolicyVersion(tdb, { scope: "member", scopeId: m.id, rules: { notify: { helpersNotifyAt: "critical" } } });
    expect(await latestMemberRules(tdb, m.id)).toEqual({ notify: { helpersNotifyAt: "critical" } });
    expect(await latestMemberRules(tenantScoped(t.db, other), m.id)).toBeUndefined();
    expect(await latestMemberRules(tdb, "not-a-uuid")).toBeUndefined();
  });
});
