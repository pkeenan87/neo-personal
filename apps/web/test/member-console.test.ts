// @vitest-environment node
/**
 * The owner's member console routes (_specs/v2-m1-elder.md section 8) on PGlite with the committed
 * migrations: owner only (the role is re-read from the database), tenant-scoped, validated, audited,
 * contact encrypted at rest, policy versions written, and the templated Elder-off email sent once.
 */
import { auditEvents, getMemberContact, members, memberships, policies, tenantScoped, type Db } from "@neo/db";
import { PolicyRulesSchema } from "@neo/verdict";
import { eq } from "drizzle-orm";
import type { Session } from "next-auth";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, PATCH } from "@/app/api/household/protected-members/[id]/route";
import { PUT as POLICY } from "@/app/api/household/protected-members/[id]/policy/route";
import { patchMember } from "@/lib/server/member-console";
import { memorySentEmails } from "@/lib/server/email/resend";
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

type Detail = {
  member: { id: string; displayName: string; role: string; mode: string; hasAccount: boolean; helperMemberIds: string[]; hasContact: boolean; birthYear: number | null };
  contactHint: string | null;
  others: { id: string; displayName: string }[];
  notify: { helpersNotifyAt: string; ownersNotifyAt: string };
  policySummary: string[];
  child: { birthYear: number | null; band: string; bandAssumed: boolean; timeZone: string | null; customized: boolean };
  isLastOwner: boolean;
};

let fx: EveFixture;
let gran: string; // a member row with no account
beforeAll(async () => {
  fx = await createEveFixture();
  const [row] = await tenantScoped(fx.db, fx.owner.tenantId).insert(members, { userId: null, displayName: "Gran", role: "adult" });
  gran = row!.id;
}, 60_000);
afterAll(async () => {
  await fx.close();
});
beforeEach(() => {
  holder.db = fx.db;
  stubBaseEnv(vi);
  vi.stubEnv("DEV_AUTH_BYPASS", "false"); // the Auth.js session below is the identity
  memorySentEmails().length = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetMemoryState();
});

function as(p: Person, claimedRole: "owner" | "member" = p.role): void {
  hdrs.current = new Headers();
  const name = p.deviceName.split("'")[0]!;
  authState.session = { userId: p.userId, tenantId: p.tenantId, role: claimedRole, user: { email: `${name.toLowerCase()}@example.test`, name }, expires: "2099-01-01T00:00:00Z" };
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const json = (url: string, method: string, body: unknown) =>
  new Request(`http://localhost${url}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const get = (id: string) => GET(new Request("http://localhost/x"), params(id));
const patch = (id: string, body: unknown) => PATCH(json(`/api/household/protected-members/${id}`, "PATCH", body), params(id));
const policy = (id: string, body: unknown) => POLICY(json(`/api/household/protected-members/${id}/policy`, "PUT", body), params(id));
const detail = async (res: Response) => (await res.json()) as Detail;
const auditOf = async (db: Db, tenantId: string, type: string) => tenantScoped(db, tenantId).select(auditEvents, eq(auditEvents.eventType, type));
const row = async (id: string) => tenantScoped(fx.db, fx.owner.tenantId).first(members, eq(members.id, id));

describe("GET", () => {
  it("shows an owner the member, the other people to pick as helpers, and the effective policy", async () => {
    as(fx.owner);
    const res = await get(fx.kid.memberId);
    expect(res.status).toBe(200);
    const d = await detail(res);
    expect(d.member).toMatchObject({ id: fx.kid.memberId, displayName: "Kid", role: "adult", mode: "standard", hasAccount: true, hasContact: false });
    expect(d.others.map((o) => o.id).sort()).toEqual([fx.owner.memberId, gran].sort());
    expect(d.notify).toEqual({ helpersNotifyAt: "high", ownersNotifyAt: "high" });
    expect(d.policySummary.join(" ")).toMatch(/Standard mode/);
    expect(d.isLastOwner).toBe(false);
    expect((await detail(await get(fx.owner.memberId))).isLastOwner).toBe(true);
  });

  it("is 403 for a household member, 404 for another household's owner and for a bad id", async () => {
    as(fx.kid);
    expect((await get(fx.kid.memberId)).status).toBe(403);
    expect(((await (await get(fx.owner.memberId)).json()) as { code: string }).code).toBe("forbidden");
    as(fx.other);
    expect((await get(fx.kid.memberId)).status).toBe(404);
    expect((await get("not-a-uuid")).status).toBe(404);
    as(fx.owner);
    expect((await get(crypto.randomUUID())).status).toBe(404);
  });

  it("is 401 without a session", async () => {
    authState.session = null;
    hdrs.current = new Headers();
    expect((await get(fx.kid.memberId)).status).toBe(401);
  });

  it("is 403 for a desktop token", async () => {
    as(fx.owner);
    hdrs.current = new Headers({ authorization: "Bearer neo_dt_" + "a".repeat(40) });
    expect([401, 403]).toContain((await get(fx.kid.memberId)).status);
  });
});

describe("PATCH access and validation", () => {
  it("refuses a member and changes nothing", async () => {
    as(fx.kid);
    const res = await patch(fx.kid.memberId, { displayName: "Boss" });
    expect(res.status).toBe(403);
    expect((await row(fx.kid.memberId))?.displayName).toBe("Kid");
  });

  it("refuses a demoted owner whose session still says owner", async () => {
    const t = tenantScoped(fx.db, fx.owner.tenantId);
    await t.update(memberships, { role: "member" }, eq(memberships.userId, fx.owner.userId));
    try {
      as(fx.owner, "owner");
      expect((await patch(fx.kid.memberId, { displayName: "Nope" })).status).toBe(403);
      expect((await get(fx.kid.memberId)).status).toBe(403);
      expect((await policy(fx.kid.memberId, { helpersNotifyAt: "low" })).status).toBe(403);
    } finally {
      await t.update(memberships, { role: "owner" }, eq(memberships.userId, fx.owner.userId));
    }
    expect((await row(fx.kid.memberId))?.displayName).toBe("Kid");
  });

  it("answers 404 for another household's member", async () => {
    as(fx.other);
    expect((await patch(fx.kid.memberId, { displayName: "Hacked" })).status).toBe(404);
    expect((await policy(fx.kid.memberId, { helpersNotifyAt: "low" })).status).toBe(404);
    expect((await row(fx.kid.memberId))?.displayName).toBe("Kid");
  });

  it("rejects bad bodies and unknown keys with 400, and treats blank strings as absent", async () => {
    as(fx.owner);
    for (const body of [null, [], { tenantId: fx.other.tenantId }, { mode: "root" }, { role: "boss" }, { helperMemberIds: "x" }, { helperMemberIds: ["nope"] }]) {
      expect((await patch(fx.kid.memberId, body)).status).toBe(400);
    }
    const blank = await patch(fx.kid.memberId, { displayName: "", role: "", mode: "", helperMemberIds: null, contact: undefined });
    expect(blank.status).toBe(200);
    expect((await detail(blank)).member).toMatchObject({ displayName: "Kid", role: "adult", mode: "standard" });
    expect((await patch(fx.kid.memberId, { displayName: "x".repeat(81) })).status).toBe(400);
    expect(((await (await patch(fx.kid.memberId, { mode: "child" })).json()) as { code: string }).code).toBe("birth_year_required");
  });

  it("renames, changes the role, and audits what changed without values", async () => {
    as(fx.owner);
    const res = await patch(fx.kid.memberId, { displayName: "Kiddo", role: "child" });
    expect(res.status).toBe(200);
    expect((await detail(res)).member).toMatchObject({ displayName: "Kiddo", role: "child" });
    expect((await auditOf(fx.db, fx.owner.tenantId, "member.updated")).at(-1)?.metadata).toEqual({ memberId: fx.kid.memberId, fields: ["displayName", "role"] });
    await patch(fx.kid.memberId, { displayName: "Kid", role: "adult" });
  });
});

describe("PATCH last owner", () => {
  it("keeps the only owner in Standard mode and in the owner role (409)", async () => {
    as(fx.owner);
    const mode = await patch(fx.owner.memberId, { mode: "elder" });
    expect(mode.status).toBe(409);
    expect(((await mode.json()) as { code: string }).code).toBe("last_owner");
    expect((await patch(fx.owner.memberId, { role: "adult" })).status).toBe(409);
    expect((await patch(fx.kid.memberId, { role: "owner" })).status).toBe(409);
    expect((await row(fx.owner.memberId))).toMatchObject({ mode: "standard", role: "owner" });
    // The owner role is shown, not editable: re-sending it is a no-op.
    expect((await patch(fx.owner.memberId, { role: "owner", displayName: "Pat" })).status).toBe(200);
  });
});

describe("PATCH helpers", () => {
  it("rejects a self-helper, a stranger, another household's member and more than ten", async () => {
    as(fx.owner);
    const self = await patch(fx.kid.memberId, { helperMemberIds: [fx.kid.memberId] });
    expect(self.status).toBe(400);
    expect(((await self.json()) as { code: string }).code).toBe("invalid_helper");
    expect((await patch(fx.kid.memberId, { helperMemberIds: [crypto.randomUUID()] })).status).toBe(400);
    expect((await patch(fx.kid.memberId, { helperMemberIds: [fx.other.memberId] })).status).toBe(400);
    expect((await patch(fx.kid.memberId, { helperMemberIds: Array.from({ length: 11 }, () => crypto.randomUUID()) })).status).toBe(400);
    expect((await row(fx.kid.memberId))?.helperMemberIds).toEqual([]);
  });

  it("stores helpers (deduplicated), audits counts, and clears them with an empty list", async () => {
    as(fx.owner);
    const res = await patch(fx.kid.memberId, { helperMemberIds: [fx.owner.memberId, gran, fx.owner.memberId.toUpperCase()] });
    expect(res.status).toBe(200);
    expect((await detail(res)).member.helperMemberIds.sort()).toEqual([fx.owner.memberId, gran].sort());
    expect((await auditOf(fx.db, fx.owner.tenantId, "member.helpers_changed")).at(-1)?.metadata).toEqual({ memberId: fx.kid.memberId, count: 2, added: 2, removed: 0 });
    // The same list again changes nothing and audits nothing more.
    const n = (await auditOf(fx.db, fx.owner.tenantId, "member.helpers_changed")).length;
    await patch(fx.kid.memberId, { helperMemberIds: [gran, fx.owner.memberId] });
    expect((await auditOf(fx.db, fx.owner.tenantId, "member.helpers_changed")).length).toBe(n);
    const cleared = await patch(fx.kid.memberId, { helperMemberIds: [] });
    expect((await detail(cleared)).member.helperMemberIds).toEqual([]);
  });
});

describe("PATCH helper contact", () => {
  it("is for a member without an account only, validated, encrypted at rest, and never audited", async () => {
    as(fx.owner);
    const hasAccount = await patch(fx.kid.memberId, { contact: "kid@example.test" });
    expect(hasAccount.status).toBe(400);
    expect(((await hasAccount.json()) as { code: string }).code).toBe("has_account");
    expect(((await (await patch(gran, { contact: "not-an-email" })).json()) as { code: string }).code).toBe("invalid_email");
    expect((await row(gran))?.contactCiphertext).toBeNull();

    const res = await patch(gran, { contact: "  Gran.Smith@Example.test " });
    expect(res.status).toBe(200);
    const d = await detail(res);
    expect(d.member.hasContact).toBe(true);
    expect(d.contactHint).toBe("g***@example.test");
    expect(JSON.stringify(d)).not.toContain("gran.smith");

    const stored = (await row(gran))?.contactCiphertext;
    expect(stored).toBeTruthy();
    expect(stored).not.toContain("gran");
    expect(Buffer.from(stored!, "base64").toString("utf8")).not.toContain("example.test");
    expect(await getMemberContact(tenantScoped(fx.db, fx.owner.tenantId), gran)).toBe("gran.smith@example.test");

    const audit = await auditOf(fx.db, fx.owner.tenantId, "member.updated");
    expect(audit.at(-1)?.metadata).toEqual({ memberId: gran, fields: ["contact"] });
    expect(JSON.stringify(audit)).not.toContain("example.test");

    // Blank means no change; null clears.
    expect((await detail(await patch(gran, { contact: "" }))).member.hasContact).toBe(true);
    expect((await detail(await patch(gran, { contact: null }))).member.hasContact).toBe(false);
    expect((await row(gran))?.contactCiphertext).toBeNull();
  });
});

describe("PUT policy", () => {
  const rulesOf = async (id: string) =>
    (await tenantScoped(fx.db, fx.owner.tenantId).select(policies, eq(policies.scopeId, id))).sort((a, b) => a.version - b.version);

  it("rejects bad input and writes nothing", async () => {
    as(fx.owner);
    for (const body of [null, {}, { helpersNotifyAt: "" }, { helpersNotifyAt: "banana" }, { ownersNotifyAt: 3 }, { remote_access: { unknownPeerSeverity: "low" } }, { tenantId: "x" }]) {
      expect((await policy(fx.kid.memberId, body)).status).toBe(400);
    }
    expect(await rulesOf(fx.kid.memberId)).toHaveLength(0);
  });

  it("appends a validated member-scope version, merged over the current rules, and skips a no-op", async () => {
    as(fx.owner);
    const first = await policy(fx.kid.memberId, { helpersNotifyAt: "critical" });
    expect(first.status).toBe(200);
    expect((await detail(first)).notify).toEqual({ helpersNotifyAt: "critical", ownersNotifyAt: "high" });
    let versions = await rulesOf(fx.kid.memberId);
    expect(versions.map((v) => [v.scope, v.version, v.createdBy])).toEqual([["member", 1, fx.owner.userId]]);
    expect(versions[0]!.rules).toEqual({ notify: { helpersNotifyAt: "critical" } });

    // Same value again: no new version, no audit.
    const audits = (await auditOf(fx.db, fx.owner.tenantId, "member.policy_changed")).length;
    await policy(fx.kid.memberId, { helpersNotifyAt: "critical", ownersNotifyAt: "" });
    expect(await rulesOf(fx.kid.memberId)).toHaveLength(1);
    expect((await auditOf(fx.db, fx.owner.tenantId, "member.policy_changed")).length).toBe(audits);

    // The second field merges over the first instead of replacing it.
    await policy(fx.kid.memberId, { ownersNotifyAt: "medium" });
    versions = await rulesOf(fx.kid.memberId);
    expect(versions).toHaveLength(2);
    expect(versions[1]!.rules).toEqual({ notify: { helpersNotifyAt: "critical", ownersNotifyAt: "medium" } });
    for (const v of versions) expect(PolicyRulesSchema.safeParse(v.rules).success).toBe(true);
    expect((await auditOf(fx.db, fx.owner.tenantId, "member.policy_changed")).at(-1)?.metadata).toEqual({ memberId: fx.kid.memberId, version: 2, ownersNotifyAt: "medium" });

    // null removes the member's own setting; the default applies again.
    const reset = await detail(await policy(fx.kid.memberId, { helpersNotifyAt: null }));
    expect(reset.notify.helpersNotifyAt).toBe("high");
    expect((await rulesOf(fx.kid.memberId)).at(-1)!.rules).toEqual({ notify: { ownersNotifyAt: "medium" } });
  });

  it("describes an Elder member's effective policy in plain words", async () => {
    as(fx.owner);
    await patch(fx.kid.memberId, { mode: "elder" });
    const d = await detail(await policy(fx.kid.memberId, { helpersNotifyAt: "medium" }));
    expect(d.notify.helpersNotifyAt).toBe("medium");
    expect(d.policySummary.join("\n")).toMatch(/Elder mode/);
    expect(d.policySummary.join("\n")).toMatch(/30 minutes/);
    expect(d.policySummary.join("\n")).toMatch(/Helpers are emailed about medium alerts/);
    await patch(fx.kid.memberId, { mode: "standard" });
  });
});

describe("mode changes", () => {
  it("turning Elder on audits and sends no email; turning it off emails every owner once, templated", async () => {
    // Two owners, so "every owner" is more than one person.
    const t = tenantScoped(fx.db, fx.owner.tenantId);
    await t.update(memberships, { role: "owner" }, eq(memberships.userId, fx.kid.userId));
    try {
      as(fx.owner);
      const on = await patch(fx.kid.memberId, { mode: "elder" });
      expect(on.status).toBe(200);
      expect((await detail(on)).member.mode).toBe("elder");
      expect(memorySentEmails()).toHaveLength(0);
      expect((await auditOf(fx.db, fx.owner.tenantId, "member.mode_changed")).at(-1)?.metadata).toEqual({ memberId: fx.kid.memberId, from: "standard", to: "elder" });

      // A double submit: two requests racing past the "is it Elder?" read. (Called on the service: vitest's
      // mocked `@/auth` import is not safe to resolve twice at once, which has nothing to do with the code.)
      const actor = { tenantId: fx.owner.tenantId, userId: fx.owner.userId, role: "owner" as const };
      const [a, b] = await Promise.all([patchMember(actor, fx.kid.memberId, { mode: "standard" }), patchMember(actor, fx.kid.memberId, { mode: "standard" })]);
      expect([a.ok, b.ok]).toEqual([true, true]);
      const sent = memorySentEmails();
      expect(sent).toHaveLength(2);
      expect(sent.map((e) => e.to.split("@")[0]!.replace(/\d+$/, "")).sort()).toEqual(["kid", "pat"]);
      expect(sent[0]!.subject).toBe("Elder mode was turned off for Kid");
      expect(sent[0]!.text).toMatch(/Standard protection/);
      expect(sent[0]!.html).toContain("/settings/household/members/");

      // A later submit finds Standard already and sends nothing more.
      await patch(fx.kid.memberId, { mode: "standard" });
      expect(memorySentEmails()).toHaveLength(2);
    } finally {
      await t.update(memberships, { role: "member" }, eq(memberships.userId, fx.kid.userId));
    }
  });

  it("lets a second owner go to Elder mode when another owner remains", async () => {
    const t = tenantScoped(fx.db, fx.owner.tenantId);
    await t.update(memberships, { role: "owner" }, eq(memberships.userId, fx.kid.userId));
    try {
      as(fx.owner);
      const res = await patch(fx.owner.memberId, { mode: "elder" });
      expect(res.status).toBe(200);
      await patch(fx.owner.memberId, { mode: "standard" });
    } finally {
      await t.update(memberships, { role: "member" }, eq(memberships.userId, fx.kid.userId));
    }
  });
});
