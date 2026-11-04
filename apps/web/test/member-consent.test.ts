// @vitest-environment node
/**
 * Consent and notice before Child and Elder mode (_specs/v2-m4-hardening.md section 2) on PGlite with
 * the committed migrations: the PATCH that enables a mode needs the current consent text version
 * (and, for Elder, the owner's attestation, again whenever the helpers change), the consents are
 * recorded with their evidence, and the "what is shared" page is for owners and the member themselves.
 */
import { listConsents, members, tenantScoped } from "@neo/db";
import type { Session } from "next-auth";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as SHARED } from "@/app/api/household/protected-members/[id]/shared/route";
import { PATCH } from "@/app/api/household/protected-members/[id]/route";
import { CONSENT_TEXT_VERSION, sharedSummary } from "@/lib/consent-text";
import type { MemberSharedResponse } from "@/lib/member-types";
import { createEveFixture, type EveFixture, type Person } from "./helpers/eve-db";
import { resetMemoryState, stubBaseEnv } from "./helpers/routes";

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
let gran: string; // an elder-to-be with no account
let sam: string; // a child-to-be with no account
beforeAll(async () => {
  fx = await createEveFixture();
  const t = tenantScoped(fx.db, fx.owner.tenantId);
  gran = (await t.insert(members, { userId: null, displayName: "Gran", role: "elder" }))[0]!.id;
  sam = (await t.insert(members, { userId: null, displayName: "Sam", role: "child", birthYear: new Date().getFullYear() - 11 }))[0]!.id;
}, 60_000);
afterAll(async () => {
  await fx.close();
});
beforeEach(() => {
  holder.db = fx.db;
  stubBaseEnv(vi);
  vi.stubEnv("DEV_AUTH_BYPASS", "false");
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetMemoryState();
});

function as(p: Person): void {
  hdrs.current = new Headers();
  const name = p.deviceName.split("'")[0]!;
  authState.session = { userId: p.userId, tenantId: p.tenantId, role: p.role, user: { email: `${name.toLowerCase()}@example.test`, name }, expires: "2099-01-01T00:00:00Z" };
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const patch = (id: string, body: unknown) =>
  PATCH(new Request(`http://localhost/x`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), params(id));
const shared = (id: string) => SHARED(new Request("http://localhost/x"), params(id));
const consentsOf = async (id: string) => listConsents(tenantScoped(fx.db, fx.owner.tenantId), id);
const code = async (res: Response) => ((await res.json()) as { code?: string }).code;
const OK = { consentTextVersion: CONSENT_TEXT_VERSION };

describe("Child mode needs the current notice", () => {
  it("refuses without the version or with an old one, and records nothing", async () => {
    as(fx.owner);
    // The household time zone is needed first; set it through the real route.
    const { PUT } = await import("@/app/api/household/time-zone/route");
    expect((await PUT(new Request("http://localhost/x", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ timeZone: "America/New_York" }) }))).status).toBe(200);
    for (const body of [{ mode: "child" }, { mode: "child", consentTextVersion: "2020-01-01" }, { mode: "child", consentTextVersion: "" }]) {
      const res = await patch(sam, body);
      expect([res.status, await code(res)]).toEqual([400, "consent_required"]);
    }
    expect(await consentsOf(sam)).toEqual([]);
  });

  it("records a monitoring_notice with the mode, text version and band", async () => {
    as(fx.owner);
    const res = await patch(sam, { mode: "child", ...OK });
    expect(res.status).toBe(200);
    const rows = await consentsOf(sam);
    expect(rows.map((r) => r.kind)).toEqual(["monitoring_notice"]);
    expect(rows[0]).toMatchObject({ grantedBy: fx.owner.userId, evidence: { mode: "child", textVersion: CONSENT_TEXT_VERSION, band: "10_13" } });
  });
});

describe("Elder mode needs the notice and the owner's attestation", () => {
  it("refuses without the notice, then without the attestation", async () => {
    as(fx.owner);
    let res = await patch(gran, { mode: "elder", elderAttestation: true });
    expect([res.status, await code(res)]).toEqual([400, "consent_required"]);
    res = await patch(gran, { mode: "elder", ...OK });
    expect([res.status, await code(res)]).toEqual([400, "attestation_required"]);
    res = await patch(gran, { mode: "elder", ...OK, elderAttestation: false });
    expect(await code(res)).toBe("attestation_required");
    expect(await consentsOf(gran)).toEqual([]);
  });

  it("records the notice and an elder_self_consent by owner attestation naming the helpers", async () => {
    as(fx.owner);
    expect((await patch(gran, { helperMemberIds: [fx.owner.memberId] })).status).toBe(200); // Standard: no attestation needed
    expect(await consentsOf(gran)).toEqual([]);
    const res = await patch(gran, { mode: "elder", ...OK, elderAttestation: true });
    expect(res.status).toBe(200);
    const rows = await consentsOf(gran);
    expect(rows.map((r) => r.kind).sort()).toEqual(["elder_self_consent", "monitoring_notice"]);
    expect(rows.find((r) => r.kind === "monitoring_notice")?.evidence).toEqual({ mode: "elder", textVersion: CONSENT_TEXT_VERSION });
    expect(rows.find((r) => r.kind === "elder_self_consent")).toMatchObject({
      grantedBy: fx.owner.userId,
      evidence: { method: "owner_attestation", textVersion: CONSENT_TEXT_VERSION, helperIds: [fx.owner.memberId] },
    });
  });

  it("asks for the attestation again when the helpers change, and records the new list", async () => {
    as(fx.owner);
    const before = (await consentsOf(gran)).length;
    const res = await patch(gran, { helperMemberIds: [fx.owner.memberId, fx.kid.memberId] });
    expect([res.status, await code(res)]).toEqual([400, "attestation_required"]);
    expect((await consentsOf(gran)).length).toBe(before);
    expect((await patch(gran, { helperMemberIds: [fx.owner.memberId, fx.kid.memberId], elderAttestation: true })).status).toBe(200);
    const rows = await consentsOf(gran);
    expect(rows.length).toBe(before + 1);
    expect(rows[0]).toMatchObject({ kind: "elder_self_consent", evidence: { method: "owner_attestation", helperIds: [fx.owner.memberId, fx.kid.memberId] } });
    // Saving the same list again changes nothing and asks for nothing.
    expect((await patch(gran, { helperMemberIds: [fx.owner.memberId, fx.kid.memberId] })).status).toBe(200);
    expect((await consentsOf(gran)).length).toBe(before + 1);
  });

  it("does not need either to turn a mode off or to change Standard members", async () => {
    as(fx.owner);
    expect((await patch(gran, { mode: "standard", helperMemberIds: [] })).status).toBe(200);
    expect((await patch(gran, { displayName: "Granny" })).status).toBe(200);
    expect((await patch(sam, { mode: "standard" })).status).toBe(200);
  });
});

describe("the what-is-shared page", () => {
  it("describes Elder protection with helpers by name for an owner", async () => {
    as(fx.owner);
    expect((await patch(gran, { mode: "elder", ...OK, elderAttestation: true, helperMemberIds: [fx.kid.memberId] })).status).toBe(200);
    const res = await shared(gran);
    expect(res.status).toBe(200);
    const v = (await res.json()) as MemberSharedResponse;
    expect(v).toMatchObject({ member: { displayName: "Granny", mode: "elder", hasAccount: false }, viewerIsOwner: true, consentTextVersion: CONSENT_TEXT_VERSION });
    expect(v.helpers).toEqual(["Kid"]);
    expect(v.owners.length).toBeGreaterThan(0);
    expect(v.neverCollected.join(" ")).toMatch(/Full web addresses/);
    expect(v.retention.join(" ")).toMatch(/30 days/);
    expect(JSON.stringify(v)).not.toMatch(/@example\.test/); // no contact details
  });

  it("is open to the member themselves and refused to another member", async () => {
    as(fx.kid);
    const own = await shared(fx.kid.memberId);
    expect(own.status).toBe(200);
    expect(((await own.json()) as MemberSharedResponse).viewerIsOwner).toBe(false);
    expect((await shared(gran)).status).toBe(403);
    expect((await shared(fx.owner.memberId)).status).toBe(403);
  });

  it("is a 404 for another household's member, for an unknown id and for a bad id", async () => {
    as(fx.other);
    expect((await shared(gran)).status).toBe(404);
    as(fx.owner);
    expect((await shared(fx.other.memberId)).status).toBe(404);
    expect((await shared(crypto.randomUUID())).status).toBe(404);
    expect((await shared("nope")).status).toBe(404);
  });
});

describe("sharedSummary", () => {
  it("is derived from the mode and the device kinds", () => {
    const text = (mode: "standard" | "elder" | "child", kinds: ("browser_extension" | "desktop_agent")[]) =>
      sharedSummary(mode, kinds, false).collected.flatMap((s) => s.items).join("\n");
    expect(text("child", [])).toMatch(/No device is enrolled/);
    expect(text("child", ["browser_extension"])).toMatch(/domain and category of a site that was blocked/);
    expect(text("child", ["desktop_agent"])).toMatch(/screen-time/);
    expect(text("elder", ["desktop_agent"])).toMatch(/remote-access tools/);
    expect(text("elder", ["desktop_agent"])).not.toMatch(/screen-time/);
    expect(text("standard", ["browser_extension"])).not.toMatch(/blocked/);
  });
});
