// @vitest-environment node
import type { Verdict } from "@neo/verdict";
import type { Session } from "next-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as verdictGET } from "@/app/api/verdicts/[id]/route";
import { POST } from "@/app/api/verdicts/[id]/signin-response/route";
import type { VerdictDetailResponse } from "@/lib/dashboard-types";
import { isPlaybookId } from "@/lib/playbooks";
import { memoryCreateDesktopToken } from "@/lib/server/memory-desktop-tokens";
import { saveMemoryVerdict, setMemoryMembers } from "@/lib/server/memory-state";
import { memorySigninStore } from "@/lib/server/signin/store";
import { post, resetMemoryState, stubBaseEnv } from "./helpers/routes";
import { VERDICT_FIXTURE } from "./fixtures";

const authState = vi.hoisted(() => ({ session: null as Session | null }));
const hdrs = vi.hoisted(() => ({ current: new Headers() }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => authState.session) }));
vi.mock("next/headers", () => ({ headers: async () => hdrs.current, cookies: async () => ({ get: () => undefined, getAll: () => [] }) }));

const TENANT = "00000000-0000-4000-8000-0000000000cc";
const OTHER_TENANT = "00000000-0000-4000-8000-0000000000dd";
const OWNER = { userId: "owner-1", tenantId: TENANT, role: "owner" as const, email: "olive@example.test", name: "Olive" };
const MEMBER = { userId: "member-1", tenantId: TENANT, role: "member" as const, email: "max@example.test", name: "Max" };
const MEMBER2 = { userId: "member-2", tenantId: TENANT, role: "member" as const, email: "mia@example.test", name: "Mia" };
const OUTSIDER = { userId: "outsider-1", tenantId: OTHER_TENANT, role: "owner" as const, email: "x@example.test", name: "X" };
const CHECK = { provider: "google", event: "new_signin", device_label: "Windows", first_seen: true, coarse_location: "Seattle, WA" } as const;

function signIn(who: typeof OWNER | typeof MEMBER): void {
  vi.stubEnv("DEV_AUTH_BYPASS", "false");
  authState.session = { userId: who.userId, tenantId: who.tenantId, role: who.role, user: { email: who.email, name: who.name }, expires: "2099-01-01T00:00:00Z" };
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const answer = (id: string, body: unknown) => POST(post(`/api/verdicts/${id}/signin-response`, body), params(id));
const seed = (userId: string, patch: Partial<Verdict> = {}) =>
  saveMemoryVerdict({ tenantId: TENANT, userId, source: "inbound", verdict: { ...VERDICT_FIXTURE, subject_type: "signin_alert", signin_check: CHECK, ...patch } }).id;
const known = () => memorySigninStore.isKnownDevice(TENANT, MEMBER.userId, "google", "Windows");

beforeEach(() => {
  stubBaseEnv(vi);
  resetMemoryState();
  hdrs.current = new Headers();
  setMemoryMembers(TENANT, [OWNER, MEMBER, MEMBER2]);
  signIn(MEMBER);
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/verdicts/[id]/signin-response", () => {
  it("yes remembers the device; repeating is idempotent", async () => {
    const id = seed(MEMBER.userId);
    expect(await known()).toBe(false);
    for (let i = 0; i < 2; i++) {
      const res = await answer(id, { response: "yes" });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ ok: true });
    }
    expect(await known()).toBe(true);
  });

  it("no returns the account_takeover playbook id; the last answer wins", async () => {
    const id = seed(MEMBER.userId);
    await answer(id, { response: "yes" });
    const no = await answer(id, { response: "no" });
    expect(no.status).toBe(200);
    const body = (await no.json()) as { ok: boolean; playbook: string };
    expect(body).toEqual({ ok: true, playbook: "account_takeover" });
    expect(isPlaybookId(body.playbook)).toBe(true);
    expect(await known()).toBe(false);
    expect((await answer(id, { response: "no" })).status).toBe(200); // idempotent
    await answer(id, { response: "yes" });
    expect(await known()).toBe(true);
  });

  it("answers 404 for anyone but the verdict's own member, owners and other tenants included", async () => {
    const id = seed(MEMBER.userId);
    for (const who of [OWNER, MEMBER2, OUTSIDER]) {
      signIn(who);
      const res = await answer(id, { response: "yes" });
      expect(res.status, who.userId).toBe(404);
    }
    signIn(MEMBER);
    expect(await known()).toBe(false);
    expect((await answer("not-a-uuid", { response: "yes" })).status).toBe(404);
    expect((await answer("00000000-0000-4000-8000-000000000999", { response: "yes" })).status).toBe(404);
  });

  it("409 when the verdict has no signin_check", async () => {
    const id = seed(MEMBER.userId, { signin_check: undefined });
    const res = await answer(id, { response: "yes" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "no_signin_check" });
  });

  it("400 for a bad body", async () => {
    const id = seed(MEMBER.userId);
    for (const body of [{}, { response: "maybe" }, { response: "yes", extra: 1 }, [], "yes"]) {
      expect((await answer(id, body)).status).toBe(400);
    }
  });

  it("requires a browser session: signed out is 401, a desktop token 403", async () => {
    const id = seed(MEMBER.userId);
    authState.session = null;
    expect((await answer(id, { response: "yes" })).status).toBe(401);
    signIn(MEMBER);
    const minted = memoryCreateDesktopToken({ userId: MEMBER.userId, tenantId: TENANT, role: "member", name: "Omarchy bar" });
    if ("error" in minted) throw new Error(minted.error);
    authState.session = null;
    hdrs.current = new Headers({ authorization: `Bearer ${minted.token}` });
    const res = await answer(id, { response: "yes" });
    expect(res.status).toBe(403);
    expect(await known()).toBe(false);
  });
});

describe("verdict detail visibility of sign-in details", () => {
  const detail = async (id: string) => (await (await verdictGET(new Request("http://localhost/x"), params(id))).json()) as VerdictDetailResponse;

  it("the member sees signin_check and whether the device is remembered; the owner never sees device details", async () => {
    const id = seed(MEMBER.userId);
    const mine = await detail(id);
    expect(mine.body.signin_check).toEqual(CHECK);
    expect(mine.signinDeviceKnown).toBe(false);
    await answer(id, { response: "yes" });
    expect((await detail(id)).signinDeviceKnown).toBe(true);

    signIn(OWNER);
    const owners = await detail(id);
    expect(owners.body.signin_check).toBeUndefined();
    expect(owners.signinDeviceKnown).toBeUndefined();
    expect(JSON.stringify(owners)).not.toContain("Windows");
    expect(JSON.stringify(owners)).not.toContain("Seattle");
    expect(owners.body.verdict).toBe(VERDICT_FIXTURE.verdict); // the resulting alert stays visible
  });

  it("an owner viewing a member's alert sees only label, severity and static text", async () => {
    const id = seed(MEMBER.userId, {
      headline: "Sign-in from Windows in Seattle (203.0.113.24)",
      indicators: [{ severity: "high", category: "new_device near Seattle!", evidence: "Windows near Seattle", explanation: "Signed in from 203.0.113.24 on jordan's Windows laptop in Seattle." }],
      recommended_actions: [{ action: "Call Seattle office at 203.0.113.24", urgency: "now" }],
      iocs: { urls: ["https://evil.example.net/login?u=jordan@example.com"], domains: ["evil.example.net"], ips: ["203.0.113.24"], hashes: [], phone_numbers: [] },
    });
    signIn(OWNER);
    const owners = await detail(id);
    const text = JSON.stringify(owners);
    for (const leak of ["Seattle", "203.0.113.24", "Windows", "laptop", "jordan"]) expect(text, leak).not.toContain(leak);
    expect(owners.body.verdict).toBe(VERDICT_FIXTURE.verdict);
    expect(owners.body.indicators[0]).toMatchObject({ severity: "high", category: "indicator" });
    expect(owners.body.iocs.ips).toEqual([]);
    expect(owners.body.iocs.urls).toEqual(["https://evil.example.net"]);
    expect(owners.headline).toBe(owners.body.headline);
    // the member still sees everything
    signIn(MEMBER);
    const own = await detail(id);
    expect(own.body.indicators[0]!.evidence).toBe("Windows near Seattle");
    expect(own.body.iocs.ips).toEqual(["203.0.113.24"]);
    expect(own.headline).toContain("Seattle");
  });

  it("the owner's verdict list shows a static headline for a member's sign-in alert", async () => {
    seed(MEMBER.userId, { headline: "Sign-in from Windows in Seattle" });
    signIn(OWNER);
    const { GET: listGET } = await import("@/app/api/verdicts/route");
    const res = await listGET(new Request("http://localhost/api/verdicts"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { headline: string }[] };
    expect(JSON.stringify(body)).not.toContain("Seattle");
  });
});
