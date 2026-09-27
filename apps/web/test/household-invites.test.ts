// @vitest-environment node
/**
 * Household invite routes on the in-memory stores (_specs/household-invites.md):
 * owner creates email and link invites, invitees preview and accept, the owner
 * removes and members leave, plus role, desktop-token and rate-limit guards.
 */
import type { Session } from "next-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as householdGET } from "@/app/api/household/route";
import { DELETE as inviteDELETE } from "@/app/api/household/invites/[id]/route";
import { POST as resendPOST } from "@/app/api/household/invites/[id]/resend/route";
import { POST as invitesPOST } from "@/app/api/household/invites/route";
import { POST as leavePOST } from "@/app/api/household/leave/route";
import { DELETE as memberDELETE } from "@/app/api/household/members/[userId]/route";
import { POST as acceptPOST } from "@/app/api/invites/[secret]/accept/route";
import { GET as previewGET } from "@/app/api/invites/[secret]/route";
import type { HouseholdResponse } from "@/lib/dashboard-types";
import type { CreateInviteResponse, InvitePreviewResponse } from "@/lib/household-types";
import { memorySentEmails } from "@/lib/server/email/resend";
import { INVITE_SEND_LIMIT, INVITE_USE_LIMIT } from "@/lib/server/household";
import { memoryCreateDesktopToken } from "@/lib/server/memory-desktop-tokens";
import { resetMemoryHousehold } from "@/lib/server/memory-household";
import { memoryListMembers, setMemoryMembers } from "@/lib/server/memory-state";
import { resetRateLimits } from "@/lib/server/rate-limit";
import { post, resetMemoryState, stubBaseEnv } from "./helpers/routes";

const hdrs = vi.hoisted(() => ({ current: new Headers() }));
vi.mock("next/headers", () => ({
  headers: async () => hdrs.current,
  cookies: async () => ({ get: () => undefined, getAll: () => [] }),
}));
const authState = vi.hoisted(() => ({ session: null as Session | null }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => authState.session) }));

interface Person {
  userId: string;
  tenantId: string;
  role: "owner" | "member";
  email: string;
  name: string;
}

const OWNER: Person = { userId: "user-owner", tenantId: "00000000-0000-4000-8000-0000000000a1", role: "owner", email: "pat@example.test", name: "Pat" };
const GRANDMA: Person = { userId: "user-grandma", tenantId: "00000000-0000-4000-8000-0000000000b1", role: "owner", email: "grandma@example.test", name: "Grandma" };
const KID: Person = { userId: "user-kid", tenantId: "00000000-0000-4000-8000-0000000000c1", role: "owner", email: "kid@example.test", name: "Kid" };

function as(p: Person): void {
  hdrs.current = new Headers();
  authState.session = { userId: p.userId, tenantId: p.tenantId, role: p.role, user: { email: p.email, name: p.name }, expires: "2099-01-01T00:00:00Z" };
}

function params<T>(value: T): { params: Promise<T> } {
  return { params: Promise.resolve(value) };
}

async function createInvite(body: unknown): Promise<Response> {
  return invitesPOST(post("/api/household/invites", body));
}

async function created(body: unknown): Promise<CreateInviteResponse> {
  const res = await createInvite(body);
  expect(res.status).toBe(201);
  return (await res.json()) as CreateInviteResponse;
}

function secretOf(url: string): string {
  return url.slice(url.lastIndexOf("/") + 1);
}

function preview(secret: string): Promise<Response> {
  return previewGET(new Request(`http://localhost/api/invites/${secret}`), params({ secret }));
}

function accept(secret: string, confirmLeave = true): Promise<Response> {
  return acceptPOST(post(`/api/invites/${secret}/accept`, { confirmLeave }), params({ secret }));
}

async function householdAs(p: Person): Promise<HouseholdResponse> {
  as(p);
  return (await householdGET()).json() as Promise<HouseholdResponse>;
}

beforeEach(() => {
  stubBaseEnv(vi);
  vi.stubEnv("DEV_AUTH_BYPASS", "false");
  resetMemoryState();
  resetMemoryHousehold();
  resetRateLimits();
  memorySentEmails().length = 0;
  const g = globalThis as { __neoDesktopTokens?: unknown };
  g.__neoDesktopTokens = undefined;
  setMemoryMembers(OWNER.tenantId, [{ userId: OWNER.userId, name: OWNER.name, email: OWNER.email, role: "owner" }]);
  as(OWNER);
});
afterEach(() => vi.unstubAllEnvs());

describe("owner invites", () => {
  it("emails an invite, lists it, and the invitee joins", async () => {
    const { invite, url } = await created({ kind: "email", email: "Grandma@Example.test" });
    expect(invite).toMatchObject({ kind: "email", email: "grandma@example.test", invitedByName: "Pat" });
    expect(url).toMatch(/^http:\/\/localhost\/invite\/neo_inv_[A-Za-z0-9_-]{43}$/);

    const sent = memorySentEmails();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "grandma@example.test", idempotencyKey: `invite:${invite.id}:1` });
    expect(sent[0]!.subject).toBe("Pat invited you to Pat's household on Neo");
    expect(sent[0]!.text).toContain(url);

    const home = await householdAs(OWNER);
    expect(home.invites.map((i) => i.id)).toEqual([invite.id]);

    as(GRANDMA);
    const p = await preview(secretOf(url));
    expect(p.status).toBe(200);
    expect((await p.json()) as InvitePreviewResponse).toMatchObject({
      householdName: "Pat's household",
      inviterName: "Pat",
      kind: "email",
      emailMatches: true,
      alreadyMember: false,
      currentHousehold: { role: "owner", memberCount: 1, verdictCount: 0 },
    });

    const res = await accept(secretOf(url));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenantId: OWNER.tenantId, householdName: "Pat's household" });
    expect(memoryListMembers(OWNER.tenantId).map((m) => [m.userId, m.role])).toEqual([
      [OWNER.userId, "owner"],
      [GRANDMA.userId, "member"],
    ]);
    // The owner is told.
    expect(memorySentEmails().at(-1)).toMatchObject({ to: OWNER.email, subject: "Grandma joined Pat's household" });
    // Used: gone from the list, and a second accept is 404.
    expect((await householdAs(OWNER)).invites).toEqual([]);
    as(GRANDMA);
    expect((await accept(secretOf(url))).status).toBe(404);
  });

  it("creates a single-use link invite that anyone signed in can accept", async () => {
    const { url, invite } = await created({ kind: "link" });
    expect(invite.email).toBeNull();
    expect(memorySentEmails()).toHaveLength(0);

    as(KID);
    expect((await accept(secretOf(url))).status).toBe(200);
    as(GRANDMA);
    expect((await accept(secretOf(url))).status).toBe(404);
  });

  it("rejects bad input and duplicates with the documented codes", async () => {
    expect((await createInvite({ kind: "sms" })).status).toBe(400);
    expect((await createInvite({ kind: "email" })).status).toBe(400);
    const bad = await createInvite({ kind: "email", email: "a@b.com, c@d.com" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: "invalid_email" });

    await created({ kind: "email", email: "kid@example.test" });
    const dup = await createInvite({ kind: "email", email: "KID@example.test" });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ code: "invite_pending" });
    const self = await createInvite({ kind: "email", email: OWNER.email });
    expect(self.status).toBe(409);
    expect(await self.json()).toMatchObject({ code: "already_member" });
  });

  it("caps the household at ten including pending invites", async () => {
    for (let i = 0; i < 9; i++) await created({ kind: "link" });
    const full = await createInvite({ kind: "link" });
    expect(full.status).toBe(400);
    expect(await full.json()).toMatchObject({ code: "household_full" });
  });

  it("resends with a new link and revokes", async () => {
    const { invite, url } = await created({ kind: "email", email: "kid@example.test" });
    const resent = await resendPOST(post(`/api/household/invites/${invite.id}/resend`, {}), params({ id: invite.id }));
    expect(resent.status).toBe(200);
    const again = memorySentEmails().at(-1)!;
    expect(again.idempotencyKey).toBe(`invite:${invite.id}:2`);
    const newUrl = /http:\/\/localhost\/invite\/\S+/.exec(again.text)![0];
    expect(newUrl).not.toBe(url);

    as(KID);
    expect((await preview(secretOf(url))).status).toBe(404);
    expect((await preview(secretOf(newUrl))).status).toBe(200);

    as(OWNER);
    const revoked = await inviteDELETE(new Request("http://localhost", { method: "DELETE" }), params({ id: invite.id }));
    expect(revoked.status).toBe(204);
    expect((await inviteDELETE(new Request("http://localhost", { method: "DELETE" }), params({ id: invite.id }))).status).toBe(404);
    as(KID);
    expect((await preview(secretOf(newUrl))).status).toBe(404);
  });

  it("rate limits invite sends per household", async () => {
    for (let i = 0; i < INVITE_SEND_LIMIT.limit; i++) {
      const r = await createInvite({ kind: "email", email: `p${i}@example.test` });
      // Some are refused by the size cap; they still count against the limit.
      expect([201, 400]).toContain(r.status);
    }
    const limited = await createInvite({ kind: "link" });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();
  });
});

describe("accept guards", () => {
  it("refuses the wrong account for an email invite", async () => {
    const { url } = await created({ kind: "email", email: "grandma@example.test" });
    as(KID);
    const p = (await (await preview(secretOf(url))).json()) as InvitePreviewResponse;
    expect(p.emailMatches).toBe(false);
    const res = await accept(secretOf(url));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "email_mismatch" });
  });

  it("requires confirmLeave", async () => {
    const { url } = await created({ kind: "link" });
    as(KID);
    const res = await accept(secretOf(url), false);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "confirm_required" });
  });

  it("refuses owners with members and members of other households", async () => {
    const { url } = await created({ kind: "link" });
    setMemoryMembers(GRANDMA.tenantId, [
      { userId: GRANDMA.userId, name: "Grandma", email: GRANDMA.email, role: "owner" },
      { userId: "user-grandpa", name: "Grandpa", email: "gp@example.test", role: "member" },
    ]);
    as(GRANDMA);
    const owns = await accept(secretOf(url));
    expect(owns.status).toBe(409);
    expect(await owns.json()).toMatchObject({ code: "owns_household_with_members" });

    as({ userId: "user-grandpa", tenantId: GRANDMA.tenantId, role: "member", email: "gp@example.test", name: "Grandpa" });
    const member = await accept(secretOf(url));
    expect(member.status).toBe(409);
    expect(await member.json()).toMatchObject({ code: "already_in_household" });

    as(OWNER);
    const mine = await accept(secretOf(url));
    expect(mine.status).toBe(409);
    expect(await mine.json()).toMatchObject({ code: "already_member" });
  });

  it("returns 404 for malformed and unknown secrets", async () => {
    as(KID);
    expect((await preview("nope")).status).toBe(404);
    expect((await accept(`neo_inv_${"A".repeat(43)}`)).status).toBe(404);
  });

  it("rate limits preview and accept per user", async () => {
    as(KID);
    for (let i = 0; i < INVITE_USE_LIMIT.limit; i++) expect((await preview("nope")).status).toBe(404);
    expect((await preview("nope")).status).toBe(429);
    expect((await accept("nope")).status).toBe(429);
  });
});

describe("members", () => {
  beforeEach(() => {
    setMemoryMembers(OWNER.tenantId, [
      { userId: OWNER.userId, name: OWNER.name, email: OWNER.email, role: "owner" },
      { userId: KID.userId, name: KID.name, email: KID.email, role: "member" },
    ]);
  });
  const KID_MEMBER: Person = { ...KID, tenantId: OWNER.tenantId, role: "member" };

  it("hides invites and member emails from members and forbids owner actions", async () => {
    await created({ kind: "link" });
    const home = await householdAs(KID_MEMBER);
    expect(home.invites).toEqual([]);
    expect(home.members.every((m) => m.email === null)).toBe(true);

    const res = await createInvite({ kind: "link" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "forbidden" });
    expect((await memberDELETE(new Request("http://localhost", { method: "DELETE" }), params({ userId: OWNER.userId }))).status).toBe(403);
  });

  it("lets the owner remove a member (and emails them) but not themselves", async () => {
    const self = await memberDELETE(new Request("http://localhost", { method: "DELETE" }), params({ userId: OWNER.userId }));
    expect(self.status).toBe(400);
    expect(await self.json()).toMatchObject({ code: "cannot_remove_owner" });

    const res = await memberDELETE(new Request("http://localhost", { method: "DELETE" }), params({ userId: KID.userId }));
    expect(res.status).toBe(204);
    expect(memoryListMembers(OWNER.tenantId).map((m) => m.userId)).toEqual([OWNER.userId]);
    expect(memorySentEmails().at(-1)).toMatchObject({ to: KID.email, subject: "You were removed from Pat's household on Neo" });
    expect((await memberDELETE(new Request("http://localhost", { method: "DELETE" }), params({ userId: KID.userId }))).status).toBe(404);
  });

  it("lets a member leave but not the owner", async () => {
    const owner = await leavePOST();
    expect(owner.status).toBe(400);
    expect(await owner.json()).toMatchObject({ code: "owner_cannot_leave" });

    as(KID_MEMBER);
    expect((await leavePOST()).status).toBe(204);
    expect(memoryListMembers(OWNER.tenantId).map((m) => m.userId)).toEqual([OWNER.userId]);
  });
});

describe("desktop tokens", () => {
  it("cannot create invites, accept, remove or leave", async () => {
    const { url } = await created({ kind: "link" });
    const minted = memoryCreateDesktopToken({ userId: OWNER.userId, tenantId: OWNER.tenantId, role: "owner", name: "bar" });
    if ("error" in minted) throw new Error(minted.error);
    authState.session = null;
    hdrs.current = new Headers({ authorization: `Bearer ${minted.token}` });

    for (const res of [
      await createInvite({ kind: "link" }),
      await accept(secretOf(url)),
      await memberDELETE(new Request("http://localhost", { method: "DELETE" }), params({ userId: KID.userId })),
      await leavePOST(),
      await inviteDELETE(new Request("http://localhost", { method: "DELETE" }), params({ id: "00000000-0000-4000-8000-000000000001" })),
    ]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "browser_session_required" });
    }
  });
});
