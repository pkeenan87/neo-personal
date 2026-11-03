/**
 * Child requests (_specs/v2-m2-child.md section 8; migration 0023_child_request_tokens) on PGlite as the
 * non-owner app role: the token columns, the widened incident_actions kinds, the per-device dedupe and limits,
 * the atomic decision, the grants that are still running, and the cross-household expiry sweep.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAlert, getAlert } from "../src/alerts.js";
import {
  CHILD_REQUEST_MAX_PENDING,
  CHILD_REQUEST_MAX_PER_DAY,
  activeChildGrants,
  createChildRequest,
  decideChildRequestRow,
  expireChildRequests,
  getChildRequest,
  listChildRequests,
  markChildRequestExpired,
  revertChildRequestDecision,
  summarizeChildRequests,
} from "../src/child-requests.js";
import { recordIncidentAction } from "../src/incident-actions.js";
import { decideEnqueue, isRequestAlertKind } from "../src/outbox.js";
import { updateMemberRules, createMemberWithoutAccount, latestMemberRules } from "../src/members.js";
import { childRequests, devices } from "../src/schema/index.js";
import { tenantScoped } from "../src/tenant.js";
import { createTenantForUser } from "../src/tenants.js";
import { becomeAppUser, createTestDb, createUser, type TestDb } from "./helpers.js";

let t: TestDb;
let ownerId: string;
let tenantId: string;
let otherTenantId: string;
let kid: string;
let deviceA: string;
let deviceB: string;
let otherKid: string;
let otherDevice: string;
const HOUR = 60 * 60 * 1000;
const now = new Date();
const hash = (n: number) => String(n).padStart(64, "0");
let n = 0;

async function device(tid: string, memberId: string, name: string): Promise<string> {
  const [d] = await tenantScoped(t.db, tid).insert(devices, { memberId, kind: "desktop_agent", platform: "windows", name, clientVersion: "1", enrollment: "code" });
  return d!.id;
}

const make = (over: Partial<Parameters<typeof createChildRequest>[1]> & { deviceId?: string; tid?: string } = {}) => {
  n += 1;
  const { tid, ...rest } = over;
  return createChildRequest(tenantScoped(t.db, tid ?? tenantId), {
    memberId: kid,
    deviceId: deviceA,
    kind: "more_time",
    detail: { minutes: 10 + n },
    reason: null,
    expiresAt: new Date(now.getTime() + 6 * HOUR),
    tokenHash: hash(n),
    tokenExpiresAt: new Date(now.getTime() + 24 * HOUR),
    now,
    ...rest,
  });
};

beforeAll(async () => {
  t = await createTestDb({ createAppUserBeforeMigrations: true });
  const owner = await createUser(t.db, "Pat");
  ownerId = owner;
  tenantId = (await createTenantForUser(t.db, { userId: owner, name: "Pat's household" })).tenantId;
  const other = await createUser(t.db, "Zed");
  otherTenantId = (await createTenantForUser(t.db, { userId: other, name: "Zed's household" })).tenantId;
  await becomeAppUser(t.client);
  kid = (await createMemberWithoutAccount(tenantScoped(t.db, tenantId), { displayName: "Sam", role: "child", birthYear: 2016 })).id;
  otherKid = (await createMemberWithoutAccount(tenantScoped(t.db, otherTenantId), { displayName: "Kit", role: "child", birthYear: 2015 })).id;
  deviceA = await device(tenantId, kid, "Family PC");
  deviceB = await device(tenantId, kid, "Tablet");
  otherDevice = await device(otherTenantId, otherKid, "Kit PC");
}, 60_000);
afterAll(async () => {
  await t.close();
});

describe("migration 0023", () => {
  it("adds origin (device by default, device or engine only) to child_requests", async () => {
    const col = await t.client.query<{ column_default: string; is_nullable: string }>(`select column_default, is_nullable from information_schema.columns where table_name = 'child_requests' and column_name = 'origin'`);
    expect(col.rows[0]).toMatchObject({ column_default: "'device'::text", is_nullable: "NO" });
    await expect(
      t.db.transaction(async (tx) => {
        await tx.execute(`select set_config('app.tenant_id', '${tenantId}', true)` as never);
        await tx.execute(`insert into child_requests (tenant_id, member_id, kind, origin) values ('${tenantId}', '${kid}', 'more_time', 'robot')` as never);
      }),
    ).rejects.toThrow();
  });

  it("adds the token columns (nullable) to child_requests and keeps its row-level security", async () => {
    const cols = await t.client.query<{ column_name: string; is_nullable: string; data_type: string }>(
      `select column_name, is_nullable, data_type from information_schema.columns where table_name = 'child_requests' and column_name like 'decision_token%' order by column_name`,
    );
    expect(cols.rows).toEqual([
      { column_name: "decision_token_expires_at", is_nullable: "YES", data_type: "timestamp with time zone" },
      { column_name: "decision_token_hash", is_nullable: "YES", data_type: "text" },
    ]);
    const rls = await t.client.query<{ relrowsecurity: boolean }>(`select relrowsecurity from pg_class where relname = 'child_requests' and relnamespace = 'public'::regnamespace`);
    expect(rls.rows[0]?.relrowsecurity).toBe(true);
    const pol = await t.client.query<{ qual: string }>(`select qual from pg_policies where tablename = 'child_requests' and policyname = 'tenant_isolation'`);
    expect(pol.rows[0]?.qual).toContain("app.tenant_id");
  });

  it("widens the incident_actions kind check to approve_request and deny_request, and still rejects others", async () => {
    const alert = await createAlert(t.db, { tenantId, subjectUserId: null, kind: "child_request", severity: "medium", title: "ask", body: "x", dedupeKey: "kind-check", memberId: kid });
    for (const kind of ["approve_request", "deny_request", "mark_expected", "allow_once"] as const) {
      const row = await recordIncidentAction(t.db, tenantId, { alertId: alert!.id, kind, requestedBy: "admin", approvedBy: null, status: "done" });
      expect(row.kind).toBe(kind);
    }
    await expect(
      t.db.transaction(async (tx) => {
        await tx.execute(`select set_config('app.tenant_id', '${tenantId}', true)` as never);
        await tx.execute(`insert into incident_actions (tenant_id, alert_id, kind, requested_by, status) values ('${tenantId}', '${alert!.id}', 'delete_everything', 'admin', 'done')` as never);
      }),
    ).rejects.toThrow();
  });

  it("makes expire_child_requests executable by app_user only", async () => {
    const r = await t.client.query<{ pub: boolean }>(
      `select has_function_privilege('public', 'public.expire_child_requests(timestamptz)', 'execute') as pub`,
    );
    expect(r.rows[0]?.pub).toBe(false);
  });
});

describe("createChildRequest", () => {
  it("stores the hashed token and expiry, and returns an identical pending request instead of a second", async () => {
    const first = await make({ kind: "unblock_site", detail: { domain: "example.com", z: 1 }, tokenHash: hash(9001) });
    expect(first.outcome).toBe("created");
    if (first.outcome !== "created") return;
    expect(first.row).toMatchObject({ status: "pending", decisionTokenHash: hash(9001), memberId: kid, deviceId: deviceA });
    const again = await make({ kind: "unblock_site", detail: { z: 1, domain: "example.com" } }); // same detail, other key order
    expect(again).toMatchObject({ outcome: "existing", row: { id: first.row.id } });
    // Another device, or another kind, is a different request.
    expect((await make({ kind: "unblock_site", detail: { domain: "example.com", z: 1 }, deviceId: deviceB })).outcome).toBe("created");
  });

  it("allows at most 5 pending per device (429 territory) but lets the engine open its own", async () => {
    const tid = otherTenantId;
    const results = [];
    for (let i = 0; i < CHILD_REQUEST_MAX_PENDING + 1; i++) {
      results.push((await make({ tid, memberId: otherKid, deviceId: otherDevice, detail: { minutes: 20 + i } })).outcome);
    }
    expect(results).toEqual([...Array(CHILD_REQUEST_MAX_PENDING).fill("created"), "too_many_pending"]);
    const system = await make({ tid, memberId: otherKid, deviceId: otherDevice, kind: "install_app", detail: { app: { image: "Roblox.exe" } }, source: "system" });
    expect(system.outcome).toBe("created");
    expect(system.outcome === "created" && system.row.origin).toBe("engine");
  });

  it("counts only what the child opened: engine-opened requests neither fill the 5 pending nor the 20 a day", async () => {
    const dev = await device(tenantId, kid, "Engine PC");
    for (let i = 0; i < CHILD_REQUEST_MAX_PENDING + 2; i++) {
      const r = await make({ deviceId: dev, kind: "install_app", detail: { app: { image: `app${i}.exe` } }, source: "system" });
      expect(r.outcome === "created" && r.row.origin).toBe("engine");
    }
    const mine = await make({ deviceId: dev, detail: { minutes: 44 } });
    expect(mine.outcome === "created" && mine.row.origin).toBe("device");
    for (let i = 0; i < CHILD_REQUEST_MAX_PENDING - 1; i++) expect((await make({ deviceId: dev, detail: { minutes: 50 + i } })).outcome).toBe("created");
    expect((await make({ deviceId: dev, detail: { minutes: 90 } })).outcome).toBe("too_many_pending");
  });

  it("counts a request past its expiry as not pending", async () => {
    const tid = otherTenantId;
    const tdb = tenantScoped(t.db, tid);
    await tdb.update(childRequests, { expiresAt: new Date(now.getTime() - 1000) }, eq(childRequests.deviceId, otherDevice));
    expect((await make({ tid, memberId: otherKid, deviceId: otherDevice, detail: { minutes: 99 } })).outcome).toBe("created");
  });

  it("stops at 20 a UTC day per device, decided ones included", async () => {
    const dev = await device(tenantId, kid, "Busy PC");
    const tdb = tenantScoped(t.db, tenantId);
    for (let i = 0; i < CHILD_REQUEST_MAX_PER_DAY; i++) {
      const r = await make({ deviceId: dev, detail: { minutes: 5 + (i % 100) + i } });
      expect(r.outcome).toBe("created");
      if (r.outcome === "created") await decideChildRequestRow(tdb, r.row.id, { status: "denied", decidedBy: ownerId, grant: null, now });
    }
    expect((await make({ deviceId: dev, detail: { minutes: 119 } })).outcome).toBe("daily_limit");
  }, 30_000);

  it("never reads another household's request", async () => {
    const mine = await make({ detail: { minutes: 77 } });
    if (mine.outcome !== "created") throw new Error("expected created");
    expect(await getChildRequest(tenantScoped(t.db, otherTenantId), mine.row.id)).toBeUndefined();
    expect((await listChildRequests(tenantScoped(t.db, otherTenantId), { memberId: kid })).length).toBe(0);
  });
});

describe("decisions", () => {
  it("is one atomic claim: of two racing decisions exactly one wins, and the token is cleared", async () => {
    const r = await make({ detail: { minutes: 31 }, deviceId: deviceB });
    if (r.outcome !== "created") throw new Error("expected created");
    const tdb = tenantScoped(t.db, tenantId);
    const [a, b] = await Promise.all([
      decideChildRequestRow(tdb, r.row.id, { status: "approved", decidedBy: ownerId, grant: { minutes: 31 }, now }),
      decideChildRequestRow(tdb, r.row.id, { status: "denied", decidedBy: ownerId, grant: null, now }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const row = await getChildRequest(tdb, r.row.id);
    expect(row).toMatchObject({ decisionTokenHash: null, decisionTokenExpiresAt: null });
    expect(["approved", "denied"]).toContain(row?.status);
  });

  it("refuses to decide an expired request, and marks it expired on read", async () => {
    const r = await make({ detail: { minutes: 32 }, deviceId: deviceB, expiresAt: new Date(now.getTime() - 1) });
    if (r.outcome !== "created") throw new Error("expected created");
    const tdb = tenantScoped(t.db, tenantId);
    expect(await decideChildRequestRow(tdb, r.row.id, { status: "approved", decidedBy: ownerId, grant: null, now })).toBeUndefined();
    expect((await markChildRequestExpired(tdb, r.row.id, now))?.status).toBe("expired");
  });

  it("reverts only the claimant's own decision", async () => {
    const r = await make({ detail: { minutes: 33 }, deviceId: deviceB });
    if (r.outcome !== "created") throw new Error("expected created");
    const tdb = tenantScoped(t.db, tenantId);
    const owner = ownerId;
    await decideChildRequestRow(tdb, r.row.id, { status: "approved", decidedBy: owner, grant: { minutes: 33 }, now });
    expect(await revertChildRequestDecision(tdb, r.row.id, "someone-else")).toBe(false);
    expect(await revertChildRequestDecision(tdb, r.row.id, owner)).toBe(true);
    expect((await getChildRequest(tdb, r.row.id))?.status).toBe("pending");
  });
});

describe("activeChildGrants", () => {
  it("returns only approved grants that have not run out, by kind", async () => {
    const m = (await createMemberWithoutAccount(tenantScoped(t.db, tenantId), { displayName: "Grant kid", role: "child", birthYear: 2014 })).id;
    const dev = await device(tenantId, m, "Grant PC");
    const tdb = tenantScoped(t.db, tenantId);
    const owner = ownerId;
    const approve = async (kind: "more_time" | "unblock_site" | "install_app", detail: Record<string, unknown>, grant: Record<string, unknown>) => {
      const r = await make({ memberId: m, deviceId: dev, kind, detail });
      if (r.outcome !== "created") throw new Error("expected created");
      await decideChildRequestRow(tdb, r.row.id, { status: "approved", decidedBy: owner, grant, now });
    };
    await approve("more_time", { minutes: 30 }, { minutes: 30, until: new Date(now.getTime() + 3 * HOUR).toISOString() });
    await approve("more_time", { minutes: 45 }, { minutes: 45, until: new Date(now.getTime() - HOUR).toISOString() }); // run out
    await approve("unblock_site", { domain: "a.example" }, { domain: "a.example", scope: "once", until: new Date(now.getTime() + HOUR).toISOString() });
    await approve("unblock_site", { domain: "b.example" }, { domain: "b.example", scope: "always" }); // permanent: lives in the policy, not here
    await approve("install_app", { app: { image: "x.exe" } }, { app: { image: "x.exe" } });
    const g = await activeChildGrants(tdb, m, now);
    expect(g.moreTime.map((x) => x.minutes)).toEqual([30]);
    expect(g.allowOnce.map((x) => x.domain)).toEqual(["a.example"]);
    expect((await activeChildGrants(tenantScoped(t.db, otherTenantId), m, now)).moreTime).toEqual([]);
  });
});

describe("summarizeChildRequests", () => {
  it("counts the period's requests by kind and status", async () => {
    const rows = await summarizeChildRequests(tenantScoped(t.db, tenantId), new Date(now.getTime() - HOUR), new Date(now.getTime() + HOUR));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.count > 0)).toBe(true);
    expect(await summarizeChildRequests(tenantScoped(t.db, tenantId), new Date(now.getTime() - 10 * HOUR), new Date(now.getTime() - 9 * HOUR))).toEqual([]);
  });
});

describe("expire_child_requests", () => {
  it("expires pending requests past their expiry in every household and resolves their alerts", async () => {
    const seed = async (tid: string, memberId: string, deviceId: string, minutes: number, expiresAt: Date, key: string) => {
      const alert = await createAlert(t.db, { tenantId: tid, subjectUserId: null, kind: "child_request", severity: "medium", title: "ask", body: "x", dedupeKey: key, memberId });
      const r = await make({ tid, memberId, deviceId, detail: { minutes }, expiresAt, source: "system" });
      if (r.outcome !== "created") throw new Error("expected created");
      await tenantScoped(t.db, tid).update(childRequests, { alertId: alert!.id }, eq(childRequests.id, r.row.id));
      return { requestId: r.row.id, alertId: alert!.id };
    };
    const past = new Date(now.getTime() + HOUR); // created with a future expiry (the insert is checked at create), moved below
    const a = await seed(tenantId, kid, deviceB, 61, past, "sweep-a");
    const b = await seed(otherTenantId, otherKid, otherDevice, 62, past, "sweep-b");
    const live = await seed(tenantId, kid, deviceB, 63, new Date(now.getTime() + 5 * HOUR), "sweep-live");
    for (const [tid, id] of [[tenantId, a.requestId], [otherTenantId, b.requestId]] as const) {
      await tenantScoped(t.db, tid).update(childRequests, { expiresAt: new Date(now.getTime() - 1000) }, and(eq(childRequests.id, id)));
    }
    const count = await expireChildRequests(t.db, now);
    expect(count).toBeGreaterThanOrEqual(2);
    expect((await getChildRequest(tenantScoped(t.db, tenantId), a.requestId))).toMatchObject({ status: "expired", decisionTokenHash: null });
    expect((await getChildRequest(tenantScoped(t.db, otherTenantId), b.requestId))?.status).toBe("expired");
    expect((await getChildRequest(tenantScoped(t.db, tenantId), live.requestId))?.status).toBe("pending");
    expect((await getAlert(t.db, tenantId, a.alertId))?.status).toBe("resolved");
    expect((await getAlert(t.db, otherTenantId, b.alertId))?.status).toBe("resolved");
    expect((await getAlert(t.db, tenantId, live.alertId))?.status).toBe("open");
    expect(await expireChildRequests(t.db, now)).toBe(0); // nothing left to do
  });
});

describe("updateMemberRules", () => {
  it("writes the next member policy version, or nothing when the change returns null", async () => {
    const tdb = tenantScoped(t.db, tenantId);
    const owner = ownerId;
    expect(await updateMemberRules(tdb, kid, () => null, owner)).toBeUndefined();
    const v1 = await updateMemberRules(tdb, kid, (cur) => ({ ...(cur as object | undefined), web: { allow: ["a.example"] } }), owner);
    const v2 = await updateMemberRules(tdb, kid, (cur) => ({ ...(cur as object), apps: { approved: [{ image: "x.exe" }] } }), owner);
    expect(v2!.version).toBe(v1!.version + 1);
    expect(await latestMemberRules(tdb, kid)).toEqual({ web: { allow: ["a.example"] }, apps: { approved: [{ image: "x.exe" }] } });
  });
});

describe("the daily alert cap", () => {
  it("exempts child_request and app_approval alerts, so a request always reaches a parent", () => {
    const rows = [{ idempotencyKey: "k", address: "a@example.test", template: "alert" as const, recipientMemberId: null, recipientUserId: null, payload: {} }];
    const plan = { cap: 20 };
    expect(decideEnqueue({ severity: "medium", kind: "scam_page" }, plan, rows, () => [], 20).status).toBe("skipped");
    for (const kind of ["child_request", "app_approval"]) {
      expect(isRequestAlertKind(kind)).toBe(true);
      expect(decideEnqueue({ severity: "medium", kind }, plan, rows, () => [], 500).status).toBe("pending");
    }
    expect(isRequestAlertKind("self_harm_attempts")).toBe(false);
  });
});
