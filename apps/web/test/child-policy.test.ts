// @vitest-environment node
/**
 * Child policy on the server (_specs/v2-m2-child.md sections 2 and 3, slice 1b) on PGlite with the
 * committed migrations: creating a member without an account, enabling Child mode (birth year, household
 * time zone, consent), the policy editor's validation, the templated Child-off email, and the Child
 * signals end to end through the ingest route (alerts, dedupe keys, per-mode decisions).
 */
import { alerts, auditEvents, childRequests, deviceSignals, listConsents, members, memberships, policies, revokeMemberDevicesTx, setHouseholdTimeZone, tenantScoped } from "@neo/db";
import { PolicyRulesSchema } from "@neo/verdict";
import { eq, sql } from "drizzle-orm";
import type { Session } from "next-auth";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as enrollPOST } from "@/app/api/devices/enroll/route";
import { PUT as POLICY } from "@/app/api/household/protected-members/[id]/policy/route";
import { POST as memberCodesPOST } from "@/app/api/household/protected-members/[id]/enrollment-codes/route";
import { GET, PATCH } from "@/app/api/household/protected-members/[id]/route";
import { POST as CREATE } from "@/app/api/household/protected-members/route";
import { PUT as TIME_ZONE } from "@/app/api/household/time-zone/route";
import { POST as signalsPOST } from "@/app/api/signals/route";
import type { CreateEnrollmentCodeResponse, EnrollDeviceResponse } from "@/lib/household-types";
import type { MemberDetailResponse } from "@/lib/member-types";
import type { SignalIngestResponse } from "@/lib/signal-types";
import { memorySentEmails } from "@/lib/server/email/resend";
import { patchMember } from "@/lib/server/member-console";
import { resetRateLimits } from "@/lib/server/rate-limit";
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

type Detail = MemberDetailResponse;
type ApiError = { error: string; code: string; fields?: { path: string; message: string }[] };

let fx: EveFixture;
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const thisYear = new Date().getUTCFullYear();

function as(p: Person, claimedRole: "owner" | "member" = p.role): void {
  hdrs.current = new Headers();
  const name = p.deviceName.split("'")[0]!;
  authState.session = { userId: p.userId, tenantId: p.tenantId, role: claimedRole, user: { email: `${name.toLowerCase()}@example.test`, name }, expires: "2099-01-01T00:00:00Z" };
}
function bearer(token: string): void {
  authState.session = null;
  hdrs.current = new Headers({ authorization: `Bearer ${token}` });
}
const json = (url: string, method: string, body: unknown) => new Request(`http://localhost${url}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const create = (body: unknown) => CREATE(json("/api/household/protected-members", "POST", body));
const patch = (id: string, body: unknown) => PATCH(json(`/api/household/protected-members/${id}`, "PATCH", body), params(id));
const policy = (id: string, body: unknown) => POLICY(json(`/api/household/protected-members/${id}/policy`, "PUT", body), params(id));
const get = (id: string) => GET(new Request("http://localhost/x"), params(id));
const setZone = (body: unknown) => TIME_ZONE(json("/api/household/time-zone", "PUT", body));
const detail = async (res: Response) => (await res.json()) as Detail;
const errorOf = async (res: Response) => (await res.json()) as ApiError;
const auditOf = (type: string) => tenantScoped(fx.db, fx.owner.tenantId).select(auditEvents, eq(auditEvents.eventType, type));
const row = (id: string) => tenantScoped(fx.db, fx.owner.tenantId).first(members, eq(members.id, id));

async function addMember(body: unknown): Promise<string> {
  as(fx.owner);
  const res = await create(body);
  expect(res.status).toBe(201);
  return (await detail(res)).member.id;
}

beforeAll(async () => {
  fx = await createEveFixture();
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

describe("POST /api/household/protected-members (a member without an account)", () => {
  it("lets an owner create a child with a birth year; Standard mode, no account, audited without values", async () => {
    as(fx.owner);
    const res = await create({ displayName: "  Sam  ", role: "child", birthYear: thisYear - 9 });
    expect(res.status).toBe(201);
    const d = await detail(res);
    expect(d.member).toMatchObject({ displayName: "Sam", role: "child", mode: "standard", hasAccount: false, hasContact: false, birthYear: thisYear - 9 });
    expect(await row(d.member.id)).toMatchObject({ userId: null, role: "child", mode: "standard", birthYear: thisYear - 9, contactCiphertext: null });
    const audit = (await auditOf("member.created")).at(-1);
    expect(audit?.metadata).toEqual({ memberId: d.member.id, role: "child", hasBirthYear: true, hasContact: false });
  });

  it("creates an elder with an encrypted contact email and no birth year", async () => {
    as(fx.owner);
    const d = await detail(await create({ displayName: "Nan", role: "elder", contact: "Nan@Example.test" }));
    expect(d.member).toMatchObject({ role: "elder", hasContact: true, birthYear: null });
    expect(d.contactHint).toBe("n***@example.test");
    const stored = await row(d.member.id);
    expect(stored?.contactCiphertext).toBeTruthy();
    expect(JSON.stringify((await auditOf("member.created")).at(-1)?.metadata)).not.toContain("example.test");
  });

  it("is 403 for a household member, even one whose session claims to be an owner", async () => {
    as(fx.kid);
    const res = await create({ displayName: "Nope", role: "child", birthYear: 2015 });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe("forbidden");
    as(fx.kid, "owner");
    expect((await create({ displayName: "Nope", role: "child", birthYear: 2015 })).status).toBe(403);
    expect(await tenantScoped(fx.db, fx.owner.tenantId).count(members, eq(members.displayName, "Nope"))).toBe(0);
  });

  it("is 401 without a session and 403 for a device token", async () => {
    authState.session = null;
    hdrs.current = new Headers();
    expect((await create({ displayName: "X", role: "adult" })).status).toBe(401);
    bearer("neo_dt_" + "a".repeat(40));
    expect([401, 403]).toContain((await create({ displayName: "X", role: "adult" })).status);
  });

  it("rejects bad input with a code and creates nothing", async () => {
    as(fx.owner);
    const before = await tenantScoped(fx.db, fx.owner.tenantId).count(members);
    const cases: [unknown, string][] = [
      [null, "invalid"],
      [{ role: "child", birthYear: 2015 }, "invalid"],
      [{ displayName: "X", role: "owner" }, "invalid"],
      [{ displayName: "X", role: "boss" }, "invalid"],
      [{ displayName: "X", role: "adult", tenantId: fx.other.tenantId }, "invalid"],
      [{ displayName: "   ", role: "adult" }, "invalid_name"],
      [{ displayName: "x".repeat(81), role: "adult" }, "invalid_name"],
      [{ displayName: "X", role: "child" }, "birth_year_required"],
      [{ displayName: "X", role: "child", birthYear: 1800 }, "invalid_birth_year"],
      [{ displayName: "X", role: "child", birthYear: thisYear + 1 }, "invalid_birth_year"],
      [{ displayName: "X", role: "adult", contact: "not an email" }, "invalid_email"],
      [{ displayName: "X", role: "child", birthYear: 2015, contact: "kid@example.test" }, "contact_not_allowed"],
    ];
    for (const [body, code] of cases) {
      const res = await create(body);
      expect([res.status, (await errorOf(res)).code], JSON.stringify(body)).toEqual([400, code]);
    }
    expect(await tenantScoped(fx.db, fx.owner.tenantId).count(members)).toBe(before);
  });

  it("caps the people without an account per household (409), and the cap is per household", async () => {
    const t = tenantScoped(fx.db, fx.other.tenantId);
    for (let i = 0; i < 20; i++) await t.insert(members, { userId: null, displayName: `Kid ${i}`, role: "child" });
    as(fx.other);
    const res = await create({ displayName: "One too many", role: "child", birthYear: 2015 });
    expect([res.status, (await errorOf(res)).code]).toEqual([409, "member_limit"]);
    as(fx.owner);
    expect((await create({ displayName: "Fine", role: "child", birthYear: 2015 })).status).toBe(201);
  });

  it("gives the new member enrollment codes through the route from slice 1a", async () => {
    const id = await addMember({ displayName: "Codey", role: "child", birthYear: 2014 });
    as(fx.owner);
    const res = await memberCodesPOST(post(`/api/household/protected-members/${id}/enrollment-codes`, {}), params(id));
    expect(res.status).toBe(201);
    expect(((await res.json()) as CreateEnrollmentCodeResponse).memberName).toBe("Codey");
  });
});

describe("PUT /api/household/time-zone", () => {
  it("is owner only, validates the name, stores the canonical zone and audits the change", async () => {
    as(fx.kid);
    expect((await setZone({ timeZone: "Europe/London" })).status).toBe(403);
    as(fx.owner);
    for (const body of [null, {}, { timeZone: 5 }, { timeZone: "" }, { timeZone: "Mars/Olympus" }, { timeZone: "UTC", extra: 1 }]) {
      expect((await setZone(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await errorOf(await setZone({ timeZone: "Mars/Olympus" }))).code).toBe("invalid_time_zone");
    const ok = await setZone({ timeZone: "Europe/London" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ timeZone: "Europe/London" });
    expect((await auditOf("household.time_zone_changed")).at(-1)?.metadata).toEqual({ from: null, to: "Europe/London" });
    const n = (await auditOf("household.time_zone_changed")).length;
    await setZone({ timeZone: "Europe/London" }); // unchanged: no new audit
    expect((await auditOf("household.time_zone_changed")).length).toBe(n);
    // Another household's zone is its own.
    as(fx.other);
    expect(await (await setZone({ timeZone: "Asia/Tokyo" })).json()).toEqual({ timeZone: "Asia/Tokyo" });
    as(fx.owner);
    const d = await detail(await get(fx.owner.memberId));
    expect(d.child.timeZone).toBe("Europe/London");
    await setHouseholdTimeZone(fx.db, fx.owner.tenantId, null);
  });
});

describe("enabling and disabling Child mode", () => {
  it("needs a birth year, then a household time zone, then records a consent and picks the age band", async () => {
    await setHouseholdTimeZone(fx.db, fx.owner.tenantId, null);
    const id = await addMember({ displayName: "Lee", role: "adult" }); // no birth year
    as(fx.owner);
    expect((await errorOf(await patch(id, { mode: "child" }))).code).toBe("birth_year_required");
    expect((await errorOf(await patch(id, { mode: "child", birthYear: 1700 }))).code).toBe("invalid_birth_year");
    // A birth year in the same request is enough for that check; the time zone is next.
    const noZone = await patch(id, { mode: "child", birthYear: thisYear - 11 });
    expect([noZone.status, (await errorOf(noZone)).code]).toEqual([400, "time_zone_required"]);
    expect((await row(id))?.mode).toBe("standard");
    expect((await row(id))?.birthYear).toBeNull(); // nothing was half-applied
    expect(await listConsents(tenantScoped(fx.db, fx.owner.tenantId), id)).toEqual([]);

    expect((await setZone({ timeZone: "America/New_York" })).status).toBe(200);
    const on = await patch(id, { mode: "child", birthYear: thisYear - 11 });
    expect(on.status).toBe(200);
    const d = await detail(on);
    expect(d.member).toMatchObject({ mode: "child", birthYear: thisYear - 11 });
    expect(d.child).toMatchObject({ band: "10_13", bandAssumed: false, adult: false, timeZone: "America/New_York", customized: false });
    expect(d.child.settings.apps.requireApproval).toBe(true);
    expect(d.child.settings.screenTime.dailyMinutes).toMatchObject({ mon: 120, sat: 180 });
    expect(d.policySummary.join("\n")).toMatch(/Blocked web categories: adult content, gambling, weapons, self-harm, drugs, proxies and VPNs, dating/);
    expect(d.policySummary.join("\n")).toMatch(/Screen time: 2 hours on weekdays and 3 hours at weekends/);
    expect(d.policySummary.join("\n")).toMatch(/Downtime: 21:00 to 07:00/);

    const consents = await listConsents(tenantScoped(fx.db, fx.owner.tenantId), id);
    expect(consents).toHaveLength(1);
    expect(consents[0]).toMatchObject({ memberId: id, kind: "monitoring_notice", grantedBy: fx.owner.userId, evidence: { mode: "child", band: "10_13" } });
    expect((await auditOf("member.consent_recorded")).at(-1)?.metadata).toEqual({ memberId: id, kind: "monitoring_notice" });
    expect((await auditOf("member.mode_changed")).at(-1)?.metadata).toEqual({ memberId: id, from: "standard", to: "child" });

    // Saving the same mode again records nothing more.
    await patch(id, { mode: "child" });
    expect(await listConsents(tenantScoped(fx.db, fx.owner.tenantId), id)).toHaveLength(1);
  });

  it("uses the stored birth year when none is sent, and flags an adult birth year without refusing it", async () => {
    const id = await addMember({ displayName: "Old", role: "child", birthYear: thisYear - 20 });
    as(fx.owner);
    await setZone({ timeZone: "America/New_York" });
    const d = await detail(await patch(id, { mode: "child" }));
    expect(d.child).toMatchObject({ band: "14_17", adult: true });
    expect((await listConsents(tenantScoped(fx.db, fx.owner.tenantId), id))[0]?.evidence).toEqual({ mode: "child", band: "14_17" });
  });

  it("refuses a household member and keeps the only owner in Standard", async () => {
    const id = await addMember({ displayName: "Mia", role: "child", birthYear: 2015 });
    as(fx.kid);
    expect((await patch(id, { mode: "child" })).status).toBe(403);
    as(fx.owner);
    await setZone({ timeZone: "America/New_York" });
    const res = await patch(fx.owner.memberId, { mode: "child", birthYear: 2015 });
    expect([res.status, (await errorOf(res)).code]).toEqual([409, "last_owner"]);
    expect((await row(fx.owner.memberId))?.mode).toBe("standard");
    expect(await listConsents(tenantScoped(fx.db, fx.owner.tenantId), fx.owner.memberId)).toEqual([]);
  });

  it("emails every owner once, templated, when Child mode is turned off, and not when it is turned on", async () => {
    as(fx.owner);
    await setZone({ timeZone: "America/New_York" });
    const t = tenantScoped(fx.db, fx.owner.tenantId);
    await t.update(memberships, { role: "owner" }, eq(memberships.userId, fx.kid.userId));
    try {
      const id = await addMember({ displayName: "Zoe", role: "child", birthYear: thisYear - 8 });
      as(fx.owner);
      expect((await patch(id, { mode: "child" })).status).toBe(200);
      expect(memorySentEmails()).toHaveLength(0);

      // A double submit racing past the "is it Child?" read is one email per owner.
        const actor = { tenantId: fx.owner.tenantId, userId: fx.owner.userId, role: "owner" as const };
      const [a, b] = await Promise.all([patchMember(actor, id, { mode: "standard" }), patchMember(actor, id, { mode: "standard" })]);
      expect([a.ok, b.ok]).toEqual([true, true]);
      const sent = memorySentEmails();
      expect(sent).toHaveLength(2);
      expect(sent.map((e) => e.to.split("@")[0]!.replace(/\d+$/, "")).sort()).toEqual(["kid", "pat"]);
      expect(sent[0]!.subject).toBe("Child mode was turned off for Zoe");
      expect(sent[0]!.text).toMatch(/stop blocking sites and apps/);
      expect(sent[0]!.html).toContain(`/settings/household/members/${id}`);

      await patch(id, { mode: "standard" }); // already Standard
      expect(memorySentEmails()).toHaveLength(2);
      // Child to Elder is also "Child turned off".
      expect((await patch(id, { mode: "child" })).status).toBe(200);
      memorySentEmails().length = 0;
      expect((await patch(id, { mode: "elder" })).status).toBe(200);
      expect(memorySentEmails().map((e) => e.subject)).toEqual(["Child mode was turned off for Zoe", "Child mode was turned off for Zoe"]);
    } finally {
      await t.update(memberships, { role: "member" }, eq(memberships.userId, fx.kid.userId));
    }
  });

  it("does not send an email when Elder mode is turned off with the Elder wording (unchanged)", async () => {
    const id = await addMember({ displayName: "Ned", role: "elder" });
    as(fx.owner);
    await patch(id, { mode: "elder" });
    memorySentEmails().length = 0;
    await patch(id, { mode: "standard" });
    expect(memorySentEmails().every((e) => e.subject === "Elder mode was turned off for Ned")).toBe(true);
    expect(memorySentEmails().length).toBeGreaterThan(0);
  });
});

describe("PUT .../policy for Child settings", () => {
  let kid: string;
  beforeAll(async () => {
    await setHouseholdTimeZone(fx.db, fx.owner.tenantId, "America/New_York");
    kid = await addMember({ displayName: "Pol", role: "child", birthYear: thisYear - 12 });
    as(fx.owner);
    expect((await patch(kid, { mode: "child" })).status).toBe(200);
  });
  const rulesOf = async () => (await tenantScoped(fx.db, fx.owner.tenantId).select(policies, eq(policies.scopeId, kid))).sort((a, b) => a.version - b.version);

  it("saves web, apps and screen-time sections as a member-scope version and shows them as the settings in force", async () => {
    as(fx.owner);
    const res = await policy(kid, {
      web: { categories: ["adult", "social"], safeSearch: true, youtubeRestricted: "strict", allow: ["school.example.edu"], block: ["tiktok.com"] },
      apps: { block: [{ signer: "Roblox Corporation", image: "RobloxPlayerBeta.exe" }, { bundleId: "com.roblox.RobloxPlayer" }], requireApproval: true, approved: [{ image: "notes.exe" }] },
      screenTime: { dailyMinutes: { mon: 45, tue: 45, wed: 45, thu: 45, fri: 45, sat: null, sun: 90 }, downtime: [{ start: "20:00", end: "06:30" }], warnMinutes: 5 },
      childRequestsTo: "helpers",
    });
    expect(res.status).toBe(200);
    const d = await detail(res);
    expect(d.child.customized).toBe(true);
    expect(d.child.settings.web).toMatchObject({ categories: ["adult", "social"], youtubeRestricted: "strict", allow: ["school.example.edu"], block: ["tiktok.com"] });
    expect(d.child.settings.apps.block).toHaveLength(2);
    expect(d.child.settings.screenTime).toMatchObject({ warnMinutes: 5, downtime: [{ start: "20:00", end: "06:30" }] });
    expect(d.child.settings.screenTime.dailyMinutes).toMatchObject({ mon: 45, sat: null, sun: 90 });
    expect(d.child.settings.childRequestsTo).toBe("helpers");
    expect(d.child.defaults.web.categories).toContain("dating"); // the band's defaults are still reported
    const versions = await rulesOf();
    expect(versions.at(-1)!.createdBy).toBe(fx.owner.userId);
    expect(PolicyRulesSchema.safeParse(versions.at(-1)!.rules).success).toBe(true);
    expect((await auditOf("member.policy_changed")).at(-1)?.metadata).toEqual({ memberId: kid, version: versions.at(-1)!.version, web: "set", apps: "set", screenTime: "set", childRequestsTo: "helpers" });
  });

  it("returns 400 invalid_policy with the path of every bad field, and writes nothing", async () => {
    as(fx.owner);
    const before = (await rulesOf()).length;
    const res = await policy(kid, {
      web: { block: ["Not A Domain", "ok.example.com"], categories: ["news"] },
      apps: { block: [{}] },
      screenTime: { dailyMinutes: { mon: 2000 }, downtime: [{ start: "25:00", end: "07:00" }] },
    });
    expect(res.status).toBe(400);
    const body = await errorOf(res);
    expect(body.code).toBe("invalid_policy");
    const paths = body.fields!.map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(["web.block.0", "web.categories.0", "apps.block.0", "screenTime.dailyMinutes.mon", "screenTime.downtime.0.start"]));
    expect(body.fields!.every((f) => f.message.length > 0)).toBe(true);
    expect((await rulesOf()).length).toBe(before);
  });

  it("rejects unknown keys inside a section, list overflows and wrong types", async () => {
    as(fx.owner);
    const tooMany = Array.from({ length: 201 }, (_, i) => `s${i}.example.com`);
    for (const body of [
      { web: { categoriez: [] } },
      { web: { block: tooMany } },
      { apps: { block: Array.from({ length: 101 }, (_, i) => ({ image: `a${i}.exe` })) } },
      { screenTime: { downtime: Array.from({ length: 7 }, () => ({ start: "21:00", end: "07:00" })) } },
      { screenTime: { warnMinutes: "ten" } },
      { web: "everything" },
      { childRequestsTo: "everyone" },
    ]) {
      const res = await policy(kid, body);
      expect([res.status, (await errorOf(res)).code], JSON.stringify(body).slice(0, 60)).toEqual([400, "invalid_policy"]);
    }
  });

  it("changes nothing when the same sections are saved again, and null drops the member's own copy", async () => {
    as(fx.owner);
    const same = { web: { categories: ["adult", "social"], safeSearch: true, youtubeRestricted: "strict", allow: ["school.example.edu"], block: ["tiktok.com"] } };
    const n = (await rulesOf()).length;
    await policy(kid, same);
    expect((await rulesOf()).length).toBe(n);
    const reset = await detail(await policy(kid, { web: null, apps: null, screenTime: null, childRequestsTo: null }));
    expect(reset.child.customized).toBe(false);
    expect(reset.child.settings).toEqual(reset.child.defaults);
    expect((await rulesOf()).at(-1)!.rules).toEqual({});
    expect((await policy(kid, { web: null })).status).toBe(200); // nothing left to drop
  });

  it("keeps the notify limits working beside the new sections", async () => {
    as(fx.owner);
    const d = await detail(await policy(kid, { helpersNotifyAt: "critical", screenTime: { warnMinutes: 15 } }));
    expect(d.notify.helpersNotifyAt).toBe("critical");
    expect(d.child.settings.screenTime.warnMinutes).toBe(15);
    expect((await rulesOf()).at(-1)!.rules).toEqual({ notify: { helpersNotifyAt: "critical" }, screenTime: { warnMinutes: 15 } });
  });

  it("is owner only and tenant scoped", async () => {
    as(fx.kid);
    expect((await policy(kid, { web: { safeSearch: false } })).status).toBe(403);
    as(fx.other);
    expect((await policy(kid, { web: { safeSearch: false } })).status).toBe(404);
  });
});

// ─── The Child signals through the ingest route ────────────────────

describe("Child signals end to end", () => {
  // The earlier tests created several people without an account; the household allows 20.
  beforeAll(async () => {
    const t = tenantScoped(fx.db, fx.owner.tenantId);
    for (const m of await t.select(members, sql`${members.userId} is null`)) {
      await t.transaction(async (x) => {
        await revokeMemberDevicesTx(x.tx, fx.owner.tenantId, m.id, new Date());
        await x.delete(members, eq(members.id, m.id));
      });
    }
  });
  const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
  const blocked = (category: string, offsetMs = -1000) => ({ id: crypto.randomUUID(), type: "page", detector: "web_blocked", observedAt: iso(offsetMs), domain: "bad.test", category });
  const installed = (name = "Roblox") => ({ id: crypto.randomUUID(), type: "software", detector: "app_installed", observedAt: iso(-1000), name, signer: "Roblox Corporation", image: "RobloxPlayerBeta.exe" });
  const tamper = (reason: string) => ({ id: crypto.randomUUID(), type: "tamper", detector: "tamper_detected", observedAt: iso(-1000), reason });
  const exhausted = () => ({ id: crypto.randomUUID(), type: "usage", detector: "screen_time_exhausted", observedAt: iso(-1000) });
  const appBlocked = () => ({ id: crypto.randomUUID(), type: "software", detector: "app_blocked", observedAt: iso(-1000), name: "Fortnite", image: "Fortnite.exe" });

  async function send(token: string, events: unknown[]): Promise<SignalIngestResponse> {
    bearer(token);
    const res = await signalsPOST(post("/api/signals", { events }));
    expect(res.status).toBe(200);
    return (await res.json()) as SignalIngestResponse;
  }

  async function enrolledChild(name: string, birthYear: number, mode: "child" | "standard" = "child"): Promise<{ memberId: string; token: string; deviceId: string }> {
    const memberId = await addMember({ displayName: name, role: "child", birthYear });
    as(fx.owner);
    await setZone({ timeZone: "America/New_York" });
    if (mode === "child") expect((await patch(memberId, { mode: "child" })).status).toBe(200);
    const code = ((await (await memberCodesPOST(post(`/api/household/protected-members/${memberId}/enrollment-codes`, {}), params(memberId))).json()) as CreateEnrollmentCodeResponse).code;
    authState.session = null;
    hdrs.current = new Headers();
    const res = await enrollPOST(
      new Request("http://localhost/api/devices/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 250)}` },
        body: JSON.stringify({ code, kind: "desktop_agent", platform: "windows", name: `${name}'s PC`, clientVersion: "1.0.0" }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as EnrollDeviceResponse;
    return { memberId, token: body.token, deviceId: body.device.id };
  }

  const alertsFor = async (memberId: string) => (await tenantScoped(fx.db, fx.owner.tenantId).select(alerts, eq(alerts.memberId, memberId))).filter((a) => !a.kind.startsWith("device_"));
  const rowsFor = async (deviceId: string) => tenantScoped(fx.db, fx.owner.tenantId).select(deviceSignals, eq(deviceSignals.deviceId, deviceId));

  it("accepts every Child detector for a member without an account and stores the minimized payload", async () => {
    const c = await enrolledChild("Acc", thisYear - 12);
    const events = [blocked("adult"), appBlocked(), exhausted(), tamper("clock_changed")];
    const r = await send(c.token, events);
    expect(r.results.map((x) => x.status)).toEqual(["accepted", "accepted", "accepted", "accepted"]);
    const rows = await rowsFor(c.deviceId);
    expect(rows.map((x) => [x.detector, x.type, x.subject]).sort()).toEqual(
      [["app_blocked", "software", "Fortnite"], ["screen_time_exhausted", "usage", "screen_time"], ["tamper_detected", "tamper", "clock_changed"], ["web_blocked", "page", "bad.test"]].sort(),
    );
    expect(rows.find((x) => x.detector === "web_blocked")?.payload).toEqual({ domain: "bad.test", category: "adult", observedAt: expect.any(String) });
    expect(rows.find((x) => x.detector === "web_blocked")?.outcome).toBe("recorded");
    expect(rows.find((x) => x.detector === "app_blocked")?.outcome).toBe("recorded");
    expect(rows.find((x) => x.detector === "screen_time_exhausted")?.outcome).toBe("recorded");
  });

  it("raises self_harm_attempts on the third self-harm block, once per hour, high, about the child", async () => {
    const c = await enrolledChild("Hal", thisYear - 12);
    await send(c.token, [blocked("self_harm", -3000), blocked("self_harm", -2000)]);
    expect(await alertsFor(c.memberId)).toEqual([]); // two blocks: nothing
    const third = await send(c.token, [blocked("self_harm", -1000)]);
    expect(third.results[0]).toMatchObject({ status: "accepted", severity: "high" });
    const found = await alertsFor(c.memberId);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "self_harm_attempts", severity: "high", memberId: c.memberId, subjectUserId: null, deviceId: c.deviceId });
    expect(found[0]!.dedupeKey).toBe(`self_harm_attempts:m:${c.memberId}:${new Date().toISOString().slice(0, 13)}`);
    expect(found[0]!.title).toMatch(/Hal/);
    expect(found[0]!.body).toMatch(/gentle check-in/);
    expect(found[0]!.body).not.toMatch(/bad\.test/); // no site names in the alert

    await send(c.token, [blocked("self_harm", -500), blocked("self_harm", -400)]);
    expect(await alertsFor(c.memberId)).toHaveLength(1); // same hour: deduped
    // The alert goes out through the outbox like any other (owners at or above their threshold).
    expect(memorySentEmails().some((e) => /Hal/.test(e.subject ?? ""))).toBe(true);
  });

  it("counts self-harm blocks across a child's devices, and never mixes children", async () => {
    const a = await enrolledChild("Cee", thisYear - 12);
    const b = await enrolledChild("Dee", thisYear - 12);
    await send(a.token, [blocked("self_harm", -3000), blocked("self_harm", -2000)]);
    await send(b.token, [blocked("self_harm", -1500), blocked("self_harm", -1400)]); // another child: not a third for Cee
    expect(await alertsFor(a.memberId)).toEqual([]);
    expect(await alertsFor(b.memberId)).toEqual([]);
    // A second device for Cee.
    as(fx.owner);
    const code = ((await (await memberCodesPOST(post(`/api/household/protected-members/${a.memberId}/enrollment-codes`, {}), params(a.memberId))).json()) as CreateEnrollmentCodeResponse).code;
    authState.session = null;
    hdrs.current = new Headers();
    const second = await enrollPOST(
      new Request("http://localhost/api/devices/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.77" },
        body: JSON.stringify({ code, kind: "browser_extension", platform: "chrome", name: "Cee's Chrome", clientVersion: "1.0.0" }),
      }),
    );
    const enrolled = (await second.json()) as EnrollDeviceResponse;
    await send(enrolled.token, [blocked("self_harm", -1000)]);
    expect((await alertsFor(a.memberId)).map((x) => x.kind)).toEqual(["self_harm_attempts"]);
    expect(await alertsFor(b.memberId)).toEqual([]);
  });

  it("does not count blocks older than an hour or of other categories", async () => {
    const c = await enrolledChild("Old", thisYear - 12);
    await send(c.token, [blocked("self_harm", -23 * 3600_000), blocked("self_harm", -2 * 3600_000), blocked("drugs", -1000), blocked("drugs", -900)]);
    await send(c.token, [blocked("self_harm", -800)]);
    expect(await alertsFor(c.memberId)).toEqual([]);
  });

  it("raises app_approval (medium) for a new app in the 10-13 band, deduped per app and hour, but only records it in 14-17", async () => {
    const young = await enrolledChild("Kit", thisYear - 11);
    const r = await send(young.token, [installed()]);
    expect(r.results[0]).toMatchObject({ status: "accepted", severity: "medium" });
    const found = await alertsFor(young.memberId);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "app_approval", severity: "medium", memberId: young.memberId });
    expect(found[0]!.title).toMatch(/Roblox/);
    expect(found[0]!.dedupeKey).toBe(`app_approval:${young.deviceId}:app_installed:Roblox:${new Date().toISOString().slice(0, 13)}`);
    await send(young.token, [installed(), installed("Minecraft")]);
    expect((await alertsFor(young.memberId)).map((x) => x.title).sort().length).toBe(2); // Roblox once, Minecraft once
    // No child request is created yet (slice 3).
    expect(await tenantScoped(fx.db, fx.owner.tenantId).count(childRequests, eq(childRequests.memberId, young.memberId))).toBe(0);

    const teen = await enrolledChild("Tee", thisYear - 15);
    expect((await send(teen.token, [installed()])).results[0]).toEqual({ id: expect.any(String), status: "accepted" });
    expect(await alertsFor(teen.memberId)).toEqual([]);
    expect((await rowsFor(teen.deviceId))[0]).toMatchObject({ detector: "app_installed", outcome: "recorded" });
    // A parent who turns approval on for the teen gets the alert.
    as(fx.owner);
    await policy(teen.memberId, { apps: { requireApproval: true } });
    await send(teen.token, [installed("Steam")]);
    expect((await alertsFor(teen.memberId)).map((x) => x.kind)).toEqual(["app_approval"]);
  });

  it("raises protection_disabled (high) for tamper in Child mode, one per reason and hour, and only records it for Standard", async () => {
    const c = await enrolledChild("Tam", thisYear - 12);
    const r = await send(c.token, [tamper("vpn_app")]);
    expect(r.results[0]).toMatchObject({ status: "accepted", severity: "high" });
    const found = await alertsFor(c.memberId);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "protection_disabled", severity: "high", memberId: c.memberId });
    expect(found[0]!.body).toMatch(/VPN app/);
    await send(c.token, [tamper("vpn_app")]);
    expect(await alertsFor(c.memberId)).toHaveLength(1);
    await send(c.token, [tamper("bad_policy_signature")]);
    expect(await alertsFor(c.memberId)).toHaveLength(2);

    const std = await enrolledChild("Std", thisYear - 12, "standard");
    expect((await send(std.token, [tamper("vpn_app")])).results[0]).toEqual({ id: expect.any(String), status: "accepted" });
    expect(await alertsFor(std.memberId)).toEqual([]);
    expect((await rowsFor(std.deviceId))[0]?.outcome).toBe("recorded");
  });

  it("treats a Standard member's web blocks as plain records, however many", async () => {
    const std = await enrolledChild("Plain", thisYear - 12, "standard");
    await send(std.token, [blocked("self_harm", -4000), blocked("self_harm", -3000), blocked("self_harm", -2000), blocked("self_harm", -1000)]);
    expect(await alertsFor(std.memberId)).toEqual([]);
  });

  it("rejects an unknown tamper reason, an unknown category and a URL as invalid, in order, without failing the batch", async () => {
    const c = await enrolledChild("Bad", thisYear - 12);
    const badReason = tamper("rooted");
    const badCategory = blocked("news");
    const withUrl = { ...blocked("adult"), url: "https://bad.example.com/x" };
    const notRegistrable = { ...blocked("adult"), domain: "localhost" };
    const good = blocked("adult");
    const r = await send(c.token, [badReason, badCategory, withUrl, notRegistrable, good]);
    expect(r.results).toEqual([
      { id: badReason.id, status: "rejected", reason: "invalid" },
      { id: badCategory.id, status: "rejected", reason: "invalid" },
      { id: withUrl.id, status: "rejected", reason: "invalid" },
      { id: notRegistrable.id, status: "rejected", reason: "invalid" },
      { id: good.id, status: "accepted" },
    ]);
    expect(await rowsFor(c.deviceId)).toHaveLength(1);
  });
});
