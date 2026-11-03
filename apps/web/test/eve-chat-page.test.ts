// @vitest-environment node
/**
 * /chat-v2 behind NEO_EVE_CHAT: 404 when off (before any sign-in), an incident must be in the caller's
 * household (a member: about them), the session link route, and the alert links that switch with the flag.
 */
import type { AlertRow } from "@neo/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as linkPOST } from "@/app/api/chat-v2/incident-session/route";
import ChatV2Page from "@/app/chat-v2/page";
import { eveChatEnabled } from "@/lib/env";
import { recordSessionOwner } from "@/lib/server/eve-session-owner";
import { linkIncidentSession } from "@/lib/server/incident-data";
import { incidentChatApplies, incidentChatPath } from "@/lib/alert-types";
import { alertLink } from "@/lib/server/alerts/outbox";
import type { NeoSession } from "@/lib/session";
import { alertRow, createEveFixture, type EveFixture, type Person } from "./helpers/eve-db";
import { post, stubBaseEnv } from "./helpers/routes";

const holder = vi.hoisted(() => ({ db: null as unknown, session: null as unknown }));
vi.mock("@/lib/server/db", () => ({ getDb: () => holder.db }));
vi.mock("@/lib/session", () => ({
  requireSession: vi.fn(async () => {
    if (!holder.session) throw new Error("NEXT_REDIRECT");
    return holder.session;
  }),
  requireBrowserApiSession: vi.fn(async () =>
    holder.session ? { session: holder.session } : { response: Response.json({ error: "Sign in to continue." }, { status: 401 }) },
  ),
}));

let fx: EveFixture;
beforeAll(async () => {
  fx = await createEveFixture();
}, 60_000);
afterAll(async () => {
  await fx.close();
});
beforeEach(() => {
  holder.db = fx.db;
  stubBaseEnv(vi);
  as(fx.owner);
});
afterEach(() => vi.unstubAllEnvs());

function as(p: Person | null): void {
  holder.session = p && ({ userId: p.userId, tenantId: p.tenantId, role: p.role, email: "", name: "", scopes: ["full"] } satisfies NeoSession);
}
// The EveChat element in the rendered page tree.
const find = (el: unknown): { props: Record<string, unknown> } => {
  const stack = [el as { type?: unknown; props?: { children?: unknown } }];
  while (stack.length) {
    const n = stack.pop()!;
    if (n && typeof n === "object" && "props" in n) {
      if (typeof n.type === "function" && n.type.name === "EveChat") return n as never;
      const c = n.props?.children;
      for (const k of Array.isArray(c) ? c : [c]) if (k) stack.push(k as never);
    }
  }
  throw new Error("no EveChat");
};
const page = (query: Record<string, string> = {}) => ChatV2Page({ searchParams: Promise.resolve(query) });
const isNotFound = (e: unknown): boolean => Boolean((e as { digest?: string }).digest?.includes("404"));

describe("NEO_EVE_CHAT", () => {
  it.each([[undefined], [""], ["false"], ["1"], ["TRUE"], ["yes"]])("is off for %j", (value) => {
    vi.stubEnv("NEO_EVE_CHAT", value ?? "");
    expect(eveChatEnabled()).toBe(false);
  });

  it("is on only for exactly true", () => {
    vi.stubEnv("NEO_EVE_CHAT", "true");
    expect(eveChatEnabled()).toBe(true);
  });

  it("works when unset: /chat-v2 is a 404, even before sign-in", async () => {
    vi.stubEnv("NEO_EVE_CHAT", "");
    as(null);
    await expect(page()).rejects.toSatisfy(isNotFound);
    await expect(page({ incident: fx.kidAlertId })).rejects.toSatisfy(isNotFound);
  });

  it("makes the session link route a 404 when off", async () => {
    vi.stubEnv("NEO_EVE_CHAT", "");
    const res = await linkPOST(post("/api/chat-v2/incident-session", { incidentId: fx.kidAlertId, sessionId: "sess_1" }));
    expect(res.status).toBe(404);
    expect((await alertRow(fx.db, fx.kid.tenantId, fx.kidAlertId))?.eveSessionId).toBeNull();
  });
});

describe("/chat-v2 with the flag on", () => {
  beforeEach(() => vi.stubEnv("NEO_EVE_CHAT", "true"));

  it("requires a session", async () => {
    as(null);
    await expect(page()).rejects.toThrow("NEXT_REDIRECT");
  });

  it("renders the plain chat without an incident", async () => {
    const chat = find(await page());
    expect(chat.props).toEqual({ resumeSessionId: null });
  });

  it("opens an incident of the household for an owner, resuming a linked session", async () => {
    const first = find(await page({ incident: fx.kidAlertId.toUpperCase() }));
    expect(first.props).toMatchObject({ incidentId: fx.kidAlertId, resumeSessionId: null });
    await recordSessionOwner({ tenantId: fx.owner.tenantId, userId: fx.owner.userId }, "sess_resume");
    await linkIncidentSession({ tenantId: fx.owner.tenantId, userId: fx.owner.userId, role: "owner" }, fx.kidAlertId, "sess_resume", { ownerWaitMs: 0 });
    expect(find(await page({ incident: fx.kidAlertId })).props).toMatchObject({ resumeSessionId: "sess_resume" });
    // The link is visible to every owner of the alert but only its creator resumes it; the kid starts a new chat.
    as(fx.kid);
    expect(find(await page({ incident: fx.kidAlertId })).props).toMatchObject({ resumeSessionId: null });
  });

  it("is a 404 for another household's incident, a member's view of someone else's, and a malformed id", async () => {
    await expect(page({ incident: fx.otherAlertId })).rejects.toSatisfy(isNotFound);
    await expect(page({ incident: "not-a-uuid" })).rejects.toSatisfy(isNotFound);
    await expect(page({ incident: crypto.randomUUID() })).rejects.toSatisfy(isNotFound);
    as(fx.kid);
    await expect(page({ incident: fx.ownerAlertId })).rejects.toSatisfy(isNotFound);
    await expect(page({ incident: fx.kidAlertId })).resolves.toBeDefined();
  });
});

describe("POST /api/chat-v2/incident-session", () => {
  beforeEach(() => vi.stubEnv("NEO_EVE_CHAT", "true"));
  const link = (incidentId: string, sessionId: unknown) => linkPOST(post("/api/chat-v2/incident-session", { incidentId, sessionId }));

  it("stores the eve session on a visible alert, when the caller created that session", async () => {
    await recordSessionOwner({ tenantId: fx.owner.tenantId, userId: fx.owner.userId }, "sess_abc-1.2:3");
    expect((await link(fx.ownerAlertId, "sess_abc-1.2:3")).status).toBe(204);
    expect((await alertRow(fx.db, fx.owner.tenantId, fx.ownerAlertId))?.eveSessionId).toBe("sess_abc-1.2:3");
  });

  it("refuses another household's alert, someone else's alert for a member, and a bad session id", async () => {
    expect((await link(fx.otherAlertId, "sess_x")).status).toBe(404);
    expect((await alertRow(fx.db, fx.other.tenantId, fx.otherAlertId))?.eveSessionId).toBeNull();
    as(fx.kid);
    expect((await link(fx.ownerAlertId, "sess_kid")).status).toBe(404);
    // A visible alert but someone else's session: refused, nothing stored.
    await recordSessionOwner({ tenantId: fx.owner.tenantId, userId: fx.owner.userId }, "sess_pats");
    expect((await link(fx.kidAlertId, "sess_pats")).status).toBe(404);
    expect((await alertRow(fx.db, fx.kid.tenantId, fx.kidAlertId))?.eveSessionId).not.toBe("sess_pats");
    expect((await link(fx.kidAlertId, "has spaces")).status).toBe(400);
    expect((await link(fx.kidAlertId, 5)).status).toBe(400);
    as(null);
    expect((await link(fx.kidAlertId, "sess_1")).status).toBe(401);
  });
});

describe("alert links", () => {
  const row = (kind: AlertRow["kind"], over: Partial<AlertRow> = {}) =>
    ({ id: "a1b2c3d4-0000-4000-8000-000000000001", kind, verdictId: null, ...over }) as AlertRow;
  const APP = "https://neo.example.test";

  it("keeps the existing destinations when the flag is off", () => {
    vi.stubEnv("NEO_EVE_CHAT", "");
    expect(alertLink(row("scam_page"), APP)).toEqual({ url: `${APP}/settings/household`, label: "Open household settings" });
    expect(alertLink(row("member_verdict", { verdictId: "v1" }), APP)).toEqual({ url: `${APP}/verdicts/v1`, label: "See the check" });
    expect(alertLink(row("breach_detected"), APP).url).toBe(`${APP}/settings/breaches`);
  });

  it("points incidents at the incident chat when the flag is on", () => {
    vi.stubEnv("NEO_EVE_CHAT", "true");
    const a = row("scam_in_progress", { verdictId: "v1" });
    expect(alertLink(a, APP)).toEqual({ url: `${APP}/chat-v2?incident=${a.id}`, label: "Ask Neo about this" });
    expect(alertLink(row("protection_disabled"), APP).label).toBe("Ask Neo about this");
  });

  it("leaves household notices alone even when the flag is on", () => {
    vi.stubEnv("NEO_EVE_CHAT", "true");
    expect(alertLink(row("breach_detected"), APP).url).toBe(`${APP}/settings/breaches`);
    expect(alertLink(row("member_joined"), APP).url).toBe(`${APP}/settings/household`);
    expect(incidentChatApplies("member_left")).toBe(false);
    expect(incidentChatPath("x y")).toBe("/chat-v2?incident=x%20y");
  });
});
