// @vitest-environment node
/**
 * Member-only devices (_specs/v2-m2-child.md section 2, slice 1a) on PGlite with the committed
 * migrations: a member without an account (Gran, Elder mode) is enrolled by an owner's code, her
 * monitoring token resolves to a session with no user and no role, and everything the device does is
 * attributed to her member: heartbeat, lists, signals, the Elder correlation alert (dedupe key
 * `m:<memberId>`), the alert email (owners only, never her) and the incident tools. The same flow for a
 * member with an account keeps the old dedupe keys byte for byte.
 */
import { alerts, auditEvents, desktopTokens, deviceEnrollmentCodes, deviceSignals, devices, members, notificationOutbox, tenantScoped } from "@neo/db";
import { eq } from "drizzle-orm";
import type { Session } from "next-auth";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as enrollPOST } from "@/app/api/devices/enroll/route";
import { POST as heartbeatPOST } from "@/app/api/devices/heartbeat/route";
import { DELETE as selfDELETE } from "@/app/api/devices/self/route";
import { POST as checkUrlPOST } from "@/app/api/devices/check-url/route";
import { POST as memberCodesPOST } from "@/app/api/household/protected-members/[id]/enrollment-codes/route";
import { POST as userCodesPOST } from "@/app/api/household/members/[userId]/enrollment-codes/route";
import { GET as listsGET } from "@/app/api/signals/lists/route";
import { POST as signalsPOST } from "@/app/api/signals/route";
import { GET as statusGET } from "@/app/api/signals/status/route";
import { MOCK_URLS } from "@neo/tools";
import type { CreateEnrollmentCodeResponse, EnrollDeviceResponse, HeartbeatResponse } from "@/lib/household-types";
import type { SignalIngestResponse } from "@/lib/signal-types";
import { subjectKey } from "@/lib/server/alerts";
import { deviceTimeline, listIncidents, loadIncident } from "@/lib/server/incident-data";
import { memorySentEmails } from "@/lib/server/email/resend";
import { resetRateLimits } from "@/lib/server/rate-limit";
import { setExpectedTools } from "@/lib/server/signals/store";
import { getSession, requireDeviceSession } from "@/lib/session";
import { createEveFixture, type EveFixture, type Person } from "./helpers/eve-db";
import { post, resetMemoryState, stubBaseEnv } from "./helpers/routes";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/server/db", () => ({ getDb: () => holder.db }));
const hdrs = vi.hoisted(() => ({ current: new Headers() }));
vi.mock("next/headers", () => ({
  headers: async () => hdrs.current,
  cookies: async () => ({ get: () => undefined, getAll: () => [] }),
}));
const authState = vi.hoisted(() => ({ session: null as Session | null }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => authState.session) }));

let fx: EveFixture;
let gran: string; // a member row with no account, in Elder mode
let granDevice: { token: string; deviceId: string };

const params = (id: string) => ({ params: Promise.resolve({ id }) });

function as(p: Person): void {
  hdrs.current = new Headers();
  const name = p.deviceName.split("'")[0]!;
  authState.session = { userId: p.userId, tenantId: p.tenantId, role: p.role, user: { email: `${name.toLowerCase()}@example.test`, name }, expires: "2099-01-01T00:00:00Z" };
}
function bearer(token: string): void {
  authState.session = null;
  hdrs.current = new Headers({ authorization: `Bearer ${token}` });
}
function anonymous(): void {
  authState.session = null;
  hdrs.current = new Headers();
}

async function mintCode(p: Person, memberId: string): Promise<Response> {
  as(p);
  return memberCodesPOST(post(`/api/household/protected-members/${memberId}/enrollment-codes`, {}), params(memberId));
}

async function redeem(code: string): Promise<EnrollDeviceResponse> {
  anonymous();
  const res = await enrollPOST(
    new Request("http://localhost/api/devices/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 250)}` },
      body: JSON.stringify({ code, kind: "browser_extension", platform: "chrome", name: "Chrome on Gran's PC", clientVersion: "1.0.0" }),
    }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as EnrollDeviceResponse;
}

async function send(token: string, events: unknown[]): Promise<SignalIngestResponse> {
  bearer(token);
  const res = await signalsPOST(post("/api/signals", { events }));
  expect(res.status).toBe(200);
  return (await res.json()) as SignalIngestResponse;
}

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
const remoteSession = (peerId: string) => ({ id: crypto.randomUUID(), type: "remote_session", detector: "remote_access_session", observedAt: iso(-60_000), toolId: "anydesk", direction: "incoming", peerId });
const install = () => ({ id: crypto.randomUUID(), type: "software", detector: "unwanted_software", observedAt: iso(), name: "Scam Cleaner", reason: "publisher_list" });

const tenantAlerts = (tenantId: string) => tenantScoped(fx.db, tenantId).select(alerts);

beforeAll(async () => {
  fx = await createEveFixture();
  const t = tenantScoped(fx.db, fx.owner.tenantId);
  const [row] = await t.insert(members, { userId: null, displayName: "Gran", role: "elder", mode: "elder" });
  gran = row!.id;
  // Kid (a member with an account) is Elder too, to compare the keys of the two kinds of subject.
  await t.update(members, { mode: "elder" }, eq(members.id, fx.kid.memberId));
}, 60_000);
afterAll(async () => {
  await fx.close();
});
beforeEach(() => {
  holder.db = fx.db;
  stubBaseEnv(vi);
  vi.stubEnv("DEV_AUTH_BYPASS", "false");
  vi.stubEnv("INNGEST_EVENT_KEY", "");
  vi.stubEnv("AUTH_URL", "https://neo.example.test");
  resetMemoryState();
  resetRateLimits();
  memorySentEmails().length = 0;
});
afterEach(() => vi.unstubAllEnvs());

describe("the owner's enrollment code route for any member", () => {
  it("lets the owner mint a code for a member without an account; the response has the usual shape", async () => {
    const res = await mintCode(fx.owner, gran);
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateEnrollmentCodeResponse;
    expect(body).toMatchObject({ memberName: "Gran", code: expect.stringMatching(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/) });
    expect(Object.keys(body).sort()).toEqual(["code", "expiresAt", "id", "memberName"]);
    const audit = await tenantScoped(fx.db, fx.owner.tenantId).select(auditEvents, eq(auditEvents.eventType, "device.enrollment_code_created"));
    expect(audit.at(-1)?.metadata).toMatchObject({ codeId: body.id, memberId: gran });
    // The code is for the member, not for any account.
    const [stored] = await tenantScoped(fx.db, fx.owner.tenantId).select(deviceEnrollmentCodes, eq(deviceEnrollmentCodes.id, body.id));
    expect(stored).toMatchObject({ userId: null, memberId: gran });
  });

  it("refuses a household member (403), re-reading the role from the database", async () => {
    const res = await mintCode(fx.kid, gran);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "forbidden" });
    // A session that claims to be an owner but is not one in the database is refused too.
    as({ ...fx.kid, role: "owner" });
    const claimed = await memberCodesPOST(post(`/api/household/protected-members/${gran}/enrollment-codes`, {}), params(gran));
    expect(claimed.status).toBe(403);
  });

  it("answers 404 for another household's member, an unknown id and a malformed id", async () => {
    const [foreign] = await tenantScoped(fx.db, fx.other.tenantId).insert(members, { userId: null, displayName: "Zed's gran", role: "elder" });
    expect((await mintCode(fx.owner, foreign!.id)).status).toBe(404);
    expect((await mintCode(fx.owner, crypto.randomUUID())).status).toBe(404);
    expect((await mintCode(fx.owner, "not-a-uuid")).status).toBe(404);
    expect(await tenantScoped(fx.db, fx.other.tenantId).count(deviceEnrollmentCodes)).toBe(0);
  });

  it("still serves the user-keyed route unchanged (an account holder's code records the user and the member)", async () => {
    as(fx.owner);
    const res = await userCodesPOST(post(`/api/household/members/${fx.kid.userId}/enrollment-codes`, {}), { params: Promise.resolve({ userId: fx.kid.userId }) });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as CreateEnrollmentCodeResponse;
    const [stored] = await tenantScoped(fx.db, fx.owner.tenantId).select(deviceEnrollmentCodes, eq(deviceEnrollmentCodes.id, id));
    expect(stored).toMatchObject({ userId: fx.kid.userId, memberId: fx.kid.memberId });
  });
});

describe("a member without an account, end to end", () => {
  it("redeems a code into a device and a monitoring token with no user and no role", async () => {
    const code = ((await (await mintCode(fx.owner, gran)).json()) as CreateEnrollmentCodeResponse).code;
    const enrolled = await redeem(code);
    expect(enrolled.device).toMatchObject({ userId: null, memberName: "Gran", status: "never_seen" });
    expect(enrolled.memberName).toBe("Gran");
    granDevice = { token: enrolled.token, deviceId: enrolled.device.id };

    const t = tenantScoped(fx.db, fx.owner.tenantId);
    expect((await t.first(devices, eq(devices.id, granDevice.deviceId)))).toMatchObject({ userId: null, memberId: gran, enrollment: "code" });
    const [token] = await fx.db.select().from(desktopTokens).where(eq(desktopTokens.deviceId, granDevice.deviceId));
    expect(token).toMatchObject({ userId: null, role: null, memberId: gran, tenantId: fx.owner.tenantId });
    expect(token!.scopes).toEqual(["device", "signals:write", "url:check"]);
    // No account, so nobody to email: the enrolled-member email is skipped.
    expect(memorySentEmails().filter((m) => /enrolled|added/i.test(m.subject ?? ""))).toEqual([]);
    const audit = await t.select(auditEvents, eq(auditEvents.eventType, "device.enrolled"));
    expect(audit.at(-1)).toMatchObject({ userId: fx.owner.userId });
    expect(audit.at(-1)?.metadata).toMatchObject({ deviceId: granDevice.deviceId, userId: null, enrollment: "code" });
  });

  it("resolves the token to a device session whose member comes from the device", async () => {
    bearer(granDevice.token);
    expect(await getSession({ scope: "device" })).toMatchObject({
      userId: null,
      role: null,
      memberId: gran,
      deviceId: granDevice.deviceId,
      tenantId: fx.owner.tenantId,
    });
    // Not a person: no full-scope session, and device routes refuse nothing else.
    expect(await getSession()).toBeNull();
    const ok = await requireDeviceSession("signals:write");
    expect(ok.session?.memberId).toBe(gran);
    // A browser session is not a device session.
    as(fx.owner);
    const refused = await requireDeviceSession("device");
    expect(refused.response?.status).toBe(403);
  });

  it("heartbeats, fetches the lists, polls signal status and checks a link without ever reading a role", async () => {
    bearer(granDevice.token);
    const hb = await heartbeatPOST(post("/api/devices/heartbeat", { clientVersion: "1.0.1" }));
    expect(hb.status).toBe(200);
    const body = (await hb.json()) as HeartbeatResponse;
    expect(body).toMatchObject({ memberName: "Gran", device: { id: granDevice.deviceId, userId: null, status: "active", clientVersion: "1.0.1" } });
    expect(body.householdName).toBe("Pat's household");

    bearer(granDevice.token);
    expect((await listsGET(new Request("http://localhost/api/signals/lists"))).status).toBe(200);
    bearer(granDevice.token);
    expect((await statusGET(new Request(`http://localhost/api/signals/status?ids=${crypto.randomUUID()}`))).status).toBe(200);
    bearer(granDevice.token);
    const check = await checkUrlPOST(post("/api/devices/check-url", { url: MOCK_URLS.clean }));
    expect(check.status).toBe(200);
  });

  it("attributes signals to her member and raises the Elder correlation alert keyed m:<memberId>", async () => {
    await setExpectedTools({ tenantId: fx.owner.tenantId, deviceId: granDevice.deviceId, tools: [{ toolId: "anydesk", peerIds: ["grandson"] }], createdBy: fx.owner.userId });

    const first = await send(granDevice.token, [remoteSession("stranger")]);
    expect(first.results[0]).toMatchObject({ status: "accepted", severity: "critical" });
    await send(granDevice.token, [install()]);

    const t = tenantScoped(fx.db, fx.owner.tenantId);
    const rows = await t.select(deviceSignals, eq(deviceSignals.deviceId, granDevice.deviceId));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.memberId === gran && r.userId === null)).toBe(true);

    const mine = (await tenantAlerts(fx.owner.tenantId)).filter((a) => a.memberId === gran);
    const kinds = mine.map((a) => a.kind).sort();
    expect(kinds).toEqual(["install_during_session", "remote_access", "unwanted_software"]);
    expect(mine.every((a) => a.subjectUserId === null)).toBe(true);
    const correlation = mine.find((a) => a.kind === "install_during_session")!;
    expect(correlation.dedupeKey).toMatch(new RegExp(`^install_during_session:m:${gran}:\\d`));
    expect(correlation.signalIds).toHaveLength(2);
    // The signal alert itself keys on the device and carries the member.
    expect(mine.find((a) => a.kind === "remote_access")!.dedupeKey).toMatch(new RegExp(`^remote_access:${granDevice.deviceId}:remote_access_session:anydesk:`));

    // A second install in the same bucket is a no-op.
    await send(granDevice.token, [install()]);
    expect((await tenantAlerts(fx.owner.tenantId)).filter((a) => a.kind === "install_during_session" && a.memberId === gran)).toHaveLength(1);
  });

  it("emails the owners about her alerts and never her (she has no address, and is the subject)", async () => {
    const t = tenantScoped(fx.db, fx.owner.tenantId);
    const critical = (await tenantAlerts(fx.owner.tenantId)).filter((a) => a.memberId === gran && a.severity === "critical");
    expect(critical.length).toBeGreaterThan(0);
    for (const a of critical) {
      const rows = await t.select(notificationOutbox, eq(notificationOutbox.alertId, a.id));
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.recipientUserId === fx.owner.userId)).toBe(true);
      expect(rows.some((r) => r.recipientMemberId === gran)).toBe(false);
    }
  });

  it("shows her incidents and timeline to owners, not to another member", async () => {
    const ownerCaller = { tenantId: fx.owner.tenantId, userId: fx.owner.userId, role: "owner" as const };
    const kidCaller = { tenantId: fx.kid.tenantId, userId: fx.kid.userId, role: "member" as const };

    const list = await listIncidents(ownerCaller, { status: "all", limit: 20 });
    const hers = list.filter((i) => i.member === "Gran");
    expect(hers.map((i) => i.kind).sort()).toEqual(["install_during_session", "remote_access", "unwanted_software"]);
    expect((await listIncidents(kidCaller, { status: "all" })).some((i) => i.member === "Gran")).toBe(false);

    const incident = (await tenantAlerts(fx.owner.tenantId)).find((a) => a.kind === "remote_access" && a.memberId === gran)!;
    const seen = await loadIncident(ownerCaller, incident.id);
    expect(seen?.incident).toMatchObject({ member: "Gran", device: "Chrome on Gran's PC" });
    expect(seen?.incident.signals).toHaveLength(1);
    expect(await loadIncident(kidCaller, incident.id)).toBeNull();

    const timeline = await deviceTimeline(ownerCaller, { memberId: gran });
    expect(timeline).toMatchObject({ items: expect.any(Array) });
    expect("items" in timeline && timeline.items.map((i) => i.detector).sort()).toEqual(["remote_access_session", "unwanted_software", "unwanted_software"]);
    expect(await deviceTimeline(kidCaller, { memberId: gran })).toEqual({ error: "not_found" });
    expect(await deviceTimeline(ownerCaller, { deviceId: granDevice.deviceId })).toMatchObject({ items: expect.any(Array) });
  });

  it("unenrolls itself with no user: the audit actor is the device", async () => {
    const t = tenantScoped(fx.db, fx.owner.tenantId);
    bearer(granDevice.token);
    expect((await selfDELETE()).status).toBe(204);
    const revoked = await t.select(auditEvents, eq(auditEvents.eventType, "device.revoked"));
    const mine = revoked.find((e) => (e.metadata as { deviceId?: string }).deviceId === granDevice.deviceId)!;
    expect(mine.userId).toBeNull();
    expect(mine.metadata).toMatchObject({ by: "device", actor: `device:${granDevice.deviceId}` });
    // The device alert names her and keys on the device.
    const removed = (await tenantAlerts(fx.owner.tenantId)).find((a) => a.kind === "device_removed" && a.deviceId === granDevice.deviceId);
    expect(removed).toMatchObject({ memberId: gran, subjectUserId: null, severity: "high" });
    // The token is dead.
    bearer(granDevice.token);
    expect((await heartbeatPOST(post("/api/devices/heartbeat", {}))).status).toBe(401);
  });
});

describe("a member with an account keeps the dedupe keys it had", () => {
  it("keys the correlation alert on the user id, with the member and the user both set", async () => {
    as(fx.owner);
    const codeRes = await userCodesPOST(post(`/api/household/members/${fx.kid.userId}/enrollment-codes`, {}), { params: Promise.resolve({ userId: fx.kid.userId }) });
    const enrolled = await redeem(((await codeRes.json()) as CreateEnrollmentCodeResponse).code);
    expect(enrolled.device.userId).toBe(fx.kid.userId);
    await setExpectedTools({ tenantId: fx.kid.tenantId, deviceId: enrolled.device.id, tools: [{ toolId: "anydesk", peerIds: ["grandson"] }], createdBy: fx.owner.userId });

    bearer(enrolled.token);
    expect(await getSession({ scope: "device" })).toMatchObject({ userId: fx.kid.userId, role: "member", memberId: fx.kid.memberId, deviceId: enrolled.device.id });

    await send(enrolled.token, [remoteSession("stranger")]);
    await send(enrolled.token, [install()]);
    const mine = (await tenantAlerts(fx.kid.tenantId)).filter((a) => a.kind === "install_during_session" && a.subjectUserId === fx.kid.userId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.dedupeKey).toMatch(new RegExp(`^install_during_session:${fx.kid.userId}:\\d`));
    expect(mine[0]!.memberId).toBe(fx.kid.memberId);
    const signals = await tenantScoped(fx.db, fx.kid.tenantId).select(deviceSignals, eq(deviceSignals.deviceId, enrolled.device.id));
    expect(signals.every((s) => s.userId === fx.kid.userId && s.memberId === fx.kid.memberId)).toBe(true);
  });

  it("subjectKey is the user id when there is an account, m:<memberId> when there is not, and null without either", () => {
    expect(subjectKey({ userId: "u1", memberId: "m1" })).toBe("u1");
    expect(subjectKey({ userId: null, memberId: "m1" })).toBe("m:m1");
    expect(subjectKey({ userId: undefined, memberId: "m1" })).toBe("m:m1");
    expect(subjectKey({ userId: null, memberId: null })).toBeNull();
  });
});

describe("the in-memory twins (no database)", () => {
  const TENANT = "00000000-0000-4000-8000-0000000000f1";
  const OWNER = { userId: "user-owner", email: "pat@example.test", name: "Pat" };
  const GRAN_ID = "00000000-0000-4000-8000-0000000000a9";

  beforeEach(async () => {
    holder.db = null;
    const [{ resetMemoryAlerts }, { resetMemoryDevices }, { resetMemoryHousehold }, { resetMemoryProtection, addMemoryContactMember }, { setMemoryMembers }, { resetMemorySignals }] =
      await Promise.all([
        import("@/lib/server/memory-alerts"),
        import("@/lib/server/memory-devices"),
        import("@/lib/server/memory-household"),
        import("@/lib/server/memory-members"),
        import("@/lib/server/memory-state"),
        import("@/lib/server/memory-signals"),
      ]);
    resetMemoryAlerts();
    resetMemoryDevices();
    resetMemoryHousehold();
    resetMemoryProtection();
    resetMemorySignals();
    setMemoryMembers(TENANT, [{ userId: OWNER.userId, name: OWNER.name, email: OWNER.email, role: "owner" }]);
    addMemoryContactMember(TENANT, { id: GRAN_ID, displayName: "Gran", contact: "" });
  });

  it("enrolls a member without an account, resolves a device session with no user and attributes her signals", async () => {
    hdrs.current = new Headers();
    authState.session = { userId: OWNER.userId, tenantId: TENANT, role: "owner", user: { email: OWNER.email, name: OWNER.name }, expires: "2099-01-01T00:00:00Z" };
    const codeRes = await memberCodesPOST(post(`/api/household/protected-members/${GRAN_ID}/enrollment-codes`, {}), params(GRAN_ID));
    expect(codeRes.status).toBe(201);
    const { code, memberName } = (await codeRes.json()) as CreateEnrollmentCodeResponse;
    expect(memberName).toBe("Gran");
    const enrolled = await redeem(code);
    expect(enrolled.device).toMatchObject({ userId: null, memberName: "Gran" });

    bearer(enrolled.token);
    expect(await getSession({ scope: "device" })).toMatchObject({ userId: null, role: null, memberId: GRAN_ID, deviceId: enrolled.device.id });
    bearer(enrolled.token);
    expect(((await (await heartbeatPOST(post("/api/devices/heartbeat", {}))).json()) as HeartbeatResponse).memberName).toBe("Gran");

    const sent = await send(enrolled.token, [install()]);
    expect(sent.results[0]).toMatchObject({ status: "accepted" });
    const { memoryAlertRows } = await import("@/lib/server/memory-alerts");
    const row = memoryAlertRows().find((a) => a.tenantId === TENANT && a.kind === "unwanted_software");
    expect(row).toMatchObject({ memberId: GRAN_ID, subjectUserId: null, deviceId: enrolled.device.id });
    const { memoryListRecentMemberSignals } = await import("@/lib/server/memory-signals");
    expect(memoryListRecentMemberSignals(TENANT, GRAN_ID, { since: new Date(0) })).toHaveLength(1);
  });

  it("refuses a member's id from another household", async () => {
    authState.session = { userId: OWNER.userId, tenantId: "00000000-0000-4000-8000-0000000000f2", role: "owner", user: { email: OWNER.email, name: OWNER.name }, expires: "2099-01-01T00:00:00Z" };
    hdrs.current = new Headers();
    const res = await memberCodesPOST(post(`/api/household/protected-members/${GRAN_ID}/enrollment-codes`, {}), params(GRAN_ID));
    expect(res.status).toBe(404);
  });
});
