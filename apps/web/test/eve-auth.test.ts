// @vitest-environment node
/**
 * The eve channel's in-process caller lookup (agent/lib/app-session.ts, lib/server/session-core.ts):
 * the Auth.js session cookie read from the database, `neo_dt_` Bearer tokens (scope `full` only),
 * DEV_AUTH_BYPASS never on production/preview, and every failure is no caller.
 */
import { createDesktopToken, enrollSelfDevice, revokeDesktopToken, sessions } from "@neo/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { appSession, createAppSession, sessionIdInPath } from "../agent/lib/app-session";
import { recordSessionCreator } from "../agent/lib/session-creator";
import { cookieValues, DEV_SESSION_IDS } from "@/lib/server/session-core";
import { createEveFixture, type EveFixture } from "./helpers/eve-db";
import { stubBaseEnv } from "./helpers/routes";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/server/db", () => ({ getDb: () => holder.db }));

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
  vi.stubEnv("DEV_AUTH_BYPASS", "false");
  vi.stubEnv("NEO_EVE_CHAT", "true");
});
afterEach(() => vi.unstubAllEnvs());

function request(headers: Record<string, string>): Request {
  return new Request("http://agent.local/eve/v1/session", { method: "POST", headers });
}
const FUTURE = new Date(Date.now() + 24 * 60 * 60 * 1000);

describe("cookie session", () => {
  it("maps a valid session to a user caller with tenant and role", async () => {
    await fx.addSession(fx.kid.userId, "tok-kid", FUTURE);
    const caller = await appSession(request({ cookie: "theme=dark; authjs.session-token=tok-kid" }));
    expect(caller).toEqual({
      authenticator: "neo-session",
      principalId: fx.kid.userId,
      principalType: "user",
      attributes: { tenantId: fx.kid.tenantId, role: "member" },
    });
  });

  it("reads the __Secure- cookie, URL-encoded, and reports an owner as owner", async () => {
    await fx.addSession(fx.owner.userId, "tok owner/1", FUTURE);
    const caller = await appSession(request({ cookie: `__Secure-authjs.session-token=${encodeURIComponent("tok owner/1")}` }));
    expect(caller).toMatchObject({ principalId: fx.owner.userId, attributes: { tenantId: fx.owner.tenantId, role: "owner" } });
  });

  it("rejects an expired session, an unknown token and a request with no cookie", async () => {
    await fx.addSession(fx.kid.userId, "tok-expired", new Date(Date.now() - 1000));
    expect(await appSession(request({ cookie: "authjs.session-token=tok-expired" }))).toBeNull();
    expect(await appSession(request({ cookie: "authjs.session-token=nope" }))).toBeNull();
    expect(await appSession(request({}))).toBeNull();
    // Any other cookie is not a session.
    await fx.addSession(fx.kid.userId, "tok-other-name", FUTURE);
    expect(await appSession(request({ cookie: "session=tok-other-name" }))).toBeNull();
  });

  it("follows the database: deleting the session ends access", async () => {
    await fx.addSession(fx.kid.userId, "tok-gone", FUTURE);
    expect(await appSession(request({ cookie: "authjs.session-token=tok-gone" }))).not.toBeNull();
    await fx.db.delete(sessions).where(eq(sessions.sessionToken, "tok-gone"));
    expect(await appSession(request({ cookie: "authjs.session-token=tok-gone" }))).toBeNull();
  });

  it("fails closed when the database throws", async () => {
    await fx.addSession(fx.kid.userId, "tok-err", FUTURE);
    holder.db = { select: () => { throw new Error("db down"); } };
    expect(await appSession(request({ cookie: "authjs.session-token=tok-err" }))).toBeNull();
  });

  it("has no cookie session without a database (JWT sessions carry no tenant), as getSession()", async () => {
    holder.db = null;
    expect(await appSession(request({ cookie: "authjs.session-token=tok-kid" }))).toBeNull();
  });

  it("parses cookie headers", () => {
    expect(cookieValues('a=1; authjs.session-token="x%20y"; b=2', ["authjs.session-token"])).toEqual(["x y"]);
    expect(cookieValues("authjs.session-token=%E0%A4%A", ["authjs.session-token"])).toEqual(["%E0%A4%A"]);
    expect(cookieValues(null, ["authjs.session-token"])).toEqual([]);
  });
});

describe("neo_dt_ Bearer tokens", () => {
  it("accepts a full-scope token", async () => {
    const made = await createDesktopToken(fx.db, { userId: fx.owner.userId, tenantId: fx.owner.tenantId, role: "owner", name: "Omarchy" });
    if ("error" in made) throw new Error(made.error);
    const caller = await appSession(request({ authorization: `Bearer ${made.token}` }));
    expect(caller).toMatchObject({ principalId: fx.owner.userId, principalType: "user", attributes: { tenantId: fx.owner.tenantId, role: "owner" } });
  });

  it("rejects a device (signals:write) token: it must not get chat", async () => {
    const enrolled = await enrollSelfDevice(fx.db, {
      tenantId: fx.kid.tenantId,
      userId: fx.kid.userId,
      role: "member",
      device: { kind: "desktop_agent", platform: "linux", name: "Kid tablet", clientVersion: "1.0.0" },
    });
    if ("error" in enrolled) throw new Error(enrolled.error);
    expect(await appSession(request({ authorization: `Bearer ${enrolled.token}` }))).toBeNull();
    // Not even with a valid browser cookie alongside: the token decides on its own.
    await fx.addSession(fx.kid.userId, "tok-with-device-token", FUTURE);
    expect(await appSession(request({ authorization: `Bearer ${enrolled.token}`, cookie: "authjs.session-token=tok-with-device-token" }))).toBeNull();
  });

  it("rejects a forged or malformed token", async () => {
    expect(await appSession(request({ authorization: "Bearer neo_dt_forgedforgedforgedforgedforgedforgedforged" }))).toBeNull();
    expect(await appSession(request({ authorization: "Bearer not-a-neo-token" }))).toBeNull();
  });

  it("rejects a revoked token", async () => {
    const made = await createDesktopToken(fx.db, { userId: fx.kid.userId, tenantId: fx.kid.tenantId, role: "member", name: "Revoked" });
    if ("error" in made) throw new Error(made.error);
    expect(await appSession(request({ authorization: `Bearer ${made.token}` }))).not.toBeNull();
    expect(await revokeDesktopToken(fx.db, fx.kid.userId, made.record.id)).toBe(true);
    expect(await appSession(request({ authorization: `Bearer ${made.token}` }))).toBeNull();
  });
});

describe("DEV_AUTH_BYPASS", () => {
  beforeEach(() => vi.stubEnv("DEV_AUTH_BYPASS", "true"));

  it("gives the dev owner on a local server (no database: the fixed dev identity)", async () => {
    holder.db = null;
    expect(await appSession(request({}))).toMatchObject({
      principalId: DEV_SESSION_IDS.userId,
      attributes: { tenantId: DEV_SESSION_IDS.tenantId, role: "owner" },
    });
  });

  it.each([
    ["VERCEL_ENV=preview", { VERCEL_ENV: "preview" }],
    ["VERCEL_ENV=production", { VERCEL_ENV: "production" }],
    ["NODE_ENV=production", { NODE_ENV: "production" }],
  ])("is ignored under %s", async (_label, env) => {
    holder.db = null;
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    expect(await appSession(request({}))).toBeNull();
  });
});

describe("NEO_EVE_CHAT gates the routes", () => {
  it.each([[""], ["false"], ["1"]])("no caller at all when the flag is %j, whatever the credentials", async (flag) => {
    vi.stubEnv("NEO_EVE_CHAT", flag);
    await fx.addSession(fx.kid.userId, `tok-flag-${flag}`, FUTURE);
    expect(await appSession(request({ cookie: `authjs.session-token=tok-flag-${flag}` }))).toBeNull();
    const made = await createDesktopToken(fx.db, { userId: fx.owner.userId, tenantId: fx.owner.tenantId, role: "owner", name: `flag ${flag}` });
    if ("error" in made) throw new Error(made.error);
    expect(await appSession(request({ authorization: `Bearer ${made.token}` }))).toBeNull();
    vi.stubEnv("DEV_AUTH_BYPASS", "true");
    expect(await appSession(request({}))).toBeNull();
  });
});

describe("session ownership", () => {
  const gate = createAppSession({ ownerWaitMs: 0 });
  const onSession = (tail: string, cookie: string, method = "GET") =>
    new Request(`http://agent.local/eve/v1/session/${tail}`, { method, headers: { cookie: `authjs.session-token=${cookie}` } });
  const initiator = (p: { userId: string; tenantId: string; role: string }) => ({
    principalType: "user",
    principalId: p.userId,
    attributes: { tenantId: p.tenantId, role: p.role },
  });

  beforeAll(async () => {
    for (const [p, token] of [[fx.owner, "own-owner"], [fx.kid, "own-kid"], [fx.other, "own-other"]] as const) await fx.addSession(p.userId, token, FUTURE);
    // What the channel's `session.started` handler records.
    await recordSessionCreator("wrun_OWNED", initiator(fx.kid));
  });

  it("reads the session id from every route that names one", () => {
    for (const tail of ["wrun_X", "wrun_X/stream", "wrun_X/cancel", "wrun_X/clear", "wrun_X/compact", "wrun_X/end"]) {
      expect(sessionIdInPath(`http://a/eve/v1/session/${tail}`)).toBe("wrun_X");
    }
    expect(sessionIdInPath("http://a/eve/v1/session/wrun_X?after=1")).toBe("wrun_X");
    expect(sessionIdInPath("http://a/eve/v1/session")).toBeNull();
    expect(sessionIdInPath("http://a/eve/v1/info")).toBeNull();
  });

  it("lets the creator continue, control and stream, and anyone create", async () => {
    for (const tail of ["wrun_OWNED", "wrun_OWNED/stream", "wrun_OWNED/cancel", "wrun_OWNED/end"]) {
      expect(await gate(onSession(tail, "own-kid", tail.includes("/") && !tail.endsWith("stream") ? "POST" : "GET"))).toMatchObject({ principalId: fx.kid.userId });
    }
    expect(await gate(new Request("http://agent.local/eve/v1/session", { method: "POST", headers: { cookie: "authjs.session-token=own-kid" } }))).not.toBeNull();
  });

  it("denies another user in the same household, on continue and stream", async () => {
    expect(await gate(onSession("wrun_OWNED", "own-owner", "POST"))).toBeNull();
    expect(await gate(onSession("wrun_OWNED/stream", "own-owner"))).toBeNull();
    expect(await gate(onSession("wrun_OWNED/end", "own-owner", "POST"))).toBeNull();
  });

  it("denies a user of another household: the row is not visible to them", async () => {
    expect(await gate(onSession("wrun_OWNED", "own-other", "POST"))).toBeNull();
    expect(await gate(onSession("wrun_OWNED/stream", "own-other"))).toBeNull();
  });

  it("denies an unknown id and a malformed id", async () => {
    expect(await gate(onSession("wrun_NOPE", "own-kid", "POST"))).toBeNull();
    expect(await gate(onSession("wrun_NOPE/stream", "own-kid"))).toBeNull();
    expect(await gate(onSession("not%20valid", "own-kid"))).toBeNull();
  });

  it("denies a session with no credentials, and with the flag off", async () => {
    expect(await gate(new Request("http://agent.local/eve/v1/session/wrun_OWNED/stream"))).toBeNull();
    vi.stubEnv("NEO_EVE_CHAT", "");
    expect(await gate(onSession("wrun_OWNED/stream", "own-kid"))).toBeNull();
  });

  it("waits briefly for the record of a session that was just created", async () => {
    const patient = createAppSession({ ownerWaitMs: 2000 });
    const pending = patient(onSession("wrun_RACE/stream", "own-kid"));
    setTimeout(() => void recordSessionCreator("wrun_RACE", initiator(fx.kid)), 250);
    expect(await pending).toMatchObject({ principalId: fx.kid.userId });
  });

  it("records nothing for a creator that is not a household member", async () => {
    await recordSessionCreator("wrun_SVC", { principalType: "service", principalId: "svc", attributes: { tenantId: fx.kid.tenantId } });
    expect(await gate(onSession("wrun_SVC/stream", "own-kid"))).toBeNull();
  });

  it("keeps the first owner", async () => {
    await recordSessionCreator("wrun_OWNED", initiator(fx.owner));
    expect(await gate(onSession("wrun_OWNED/stream", "own-owner"))).toBeNull();
    expect(await gate(onSession("wrun_OWNED/stream", "own-kid"))).not.toBeNull();
  });
});
