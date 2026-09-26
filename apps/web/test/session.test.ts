// @vitest-environment node
import type { Session } from "next-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProviders, googleProfile, householdName } from "@/auth";
import { authProviders, devAuthBypassActive, emailFrom, hasBlobStore, resendApiKey } from "@/lib/env";
import { resolveAuthRedirect, safeCallbackPath } from "@/lib/safe-redirect";
import { DEV_SESSION_IDS, getSession } from "@/lib/session";
import { stubBaseEnv } from "./helpers/routes";

const authState = vi.hoisted(() => ({ session: null as Session | null, calls: 0 }));
vi.mock("@/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/auth")>()),
  auth: vi.fn(async () => {
    authState.calls++;
    return authState.session;
  }),
}));

beforeEach(() => {
  stubBaseEnv(vi);
  authState.session = null;
  authState.calls = 0;
});
afterEach(() => vi.unstubAllEnvs());

describe("DEV_AUTH_BYPASS guard", () => {
  it.each([
    [{ DEV_AUTH_BYPASS: "true", NODE_ENV: "development" }, true],
    [{ DEV_AUTH_BYPASS: "true", NODE_ENV: "test" }, true],
    [{ DEV_AUTH_BYPASS: "true", NODE_ENV: "development", VERCEL_ENV: "development" }, true],
    [{ DEV_AUTH_BYPASS: "1", NODE_ENV: "development" }, true],
    [{ DEV_AUTH_BYPASS: "true", NODE_ENV: "production" }, false],
    [{ DEV_AUTH_BYPASS: "true", NODE_ENV: "development", VERCEL_ENV: "production" }, false],
    [{ DEV_AUTH_BYPASS: "true", NODE_ENV: "development", VERCEL_ENV: "preview" }, false],
    [{ DEV_AUTH_BYPASS: "false", NODE_ENV: "development" }, false],
    [{ NODE_ENV: "development" }, false],
  ])("%j → %s", (source, expected) => {
    expect(devAuthBypassActive(source)).toBe(expected);
  });

  it("returns the fixed in-memory dev identity when active with no database", async () => {
    const s = await getSession();
    expect(s).toMatchObject({ ...DEV_SESSION_IDS, role: "owner", email: "dev@neo.local" });
    expect(authState.calls).toBe(0);
  });

  it.each(["preview", "production"])("uses real auth on VERCEL_ENV=%s even with the flag set", async (vercelEnv) => {
    vi.stubEnv("VERCEL_ENV", vercelEnv);
    expect(await getSession()).toBeNull();
    expect(authState.calls).toBe(1);
  });
});

describe("getSession with Auth.js", () => {
  beforeEach(() => vi.stubEnv("DEV_AUTH_BYPASS", "false"));

  it("maps the Auth.js session to { userId, tenantId, role }", async () => {
    authState.session = {
      userId: "u1",
      tenantId: "00000000-0000-4000-8000-000000000001",
      role: "owner",
      user: { email: "ana@example.test", name: "Ana" },
      expires: "2099-01-01T00:00:00Z",
    };
    expect(await getSession()).toEqual({
      userId: "u1",
      tenantId: "00000000-0000-4000-8000-000000000001",
      role: "owner",
      email: "ana@example.test",
      name: "Ana",
    });
  });

  it("treats a signed-in user without a household as signed out", async () => {
    authState.session = { userId: "u1", user: { email: "a@example.test" }, expires: "2099-01-01T00:00:00Z" };
    expect(await getSession()).toBeNull();
  });
});

describe("provider registration", () => {
  const db = { DATABASE_URL: "postgres://x@localhost/neo" };
  it("registers Google only with id + secret, and Resend only with a key", () => {
    expect(authProviders({ ...db })).toEqual({ google: false, resend: false });
    expect(authProviders({ ...db, AUTH_GOOGLE_ID: "id" })).toEqual({ google: false, resend: false });
    expect(authProviders({ ...db, AUTH_GOOGLE_ID: "id", AUTH_GOOGLE_SECRET: "s" })).toEqual({ google: true, resend: false });
    expect(authProviders({ ...db, AUTH_RESEND_KEY: "re_x" })).toEqual({ google: false, resend: true });
    expect(authProviders({ ...db, MESSAGING_RESEND_API_KEY: "re_marketplace" })).toEqual({ google: false, resend: true });
    expect(buildProviders({ ...db, AUTH_GOOGLE_ID: "id", AUTH_GOOGLE_SECRET: "s", AUTH_RESEND_KEY: "re_x" }).map((p) => (p as { id: string }).id)).toEqual(["google", "resend"]);
  });

  it("registers nothing without a database (the adapter needs one)", () => {
    expect(authProviders({ AUTH_GOOGLE_ID: "id", AUTH_GOOGLE_SECRET: "s", AUTH_RESEND_KEY: "re_x" })).toEqual({ google: false, resend: false });
  });

  it("offers console magic links in MOCK_MODE locally, never on a deployment", () => {
    expect(authProviders({ ...db, MOCK_MODE: "true", NODE_ENV: "development" }).resend).toBe(true);
    expect(authProviders({ ...db, MOCK_MODE: "true", VERCEL_ENV: "preview" }).resend).toBe(false);
    expect(authProviders({ ...db, MOCK_MODE: "true", NODE_ENV: "production" }).resend).toBe(false);
  });

  it("names the household after the user's first name", () => {
    expect(householdName("Ana María López")).toBe("Ana's household");
    expect(householdName("  ")).toBe("My household");
    expect(householdName(null)).toBe("My household");
  });
});

describe("callbackUrl sanitizer", () => {
  it.each(["https://evil.example/x", "//evil.example", "/\\evil.example", "javascript:alert(1)", "", "chat", "/a\nb"])(
    "rejects %j",
    (v) => {
      expect(safeCallbackPath(v)).toBe("/chat");
    },
  );

  it("accepts same-origin relative paths", () => {
    expect(safeCallbackPath("/chat/123?x=1")).toBe("/chat/123?x=1");
  });

  it("resolves Auth.js redirects to the same origin only", () => {
    const base = "https://neo.example";
    expect(resolveAuthRedirect("/chat", base)).toBe("https://neo.example/chat");
    expect(resolveAuthRedirect("https://neo.example/chat/1", base)).toBe("https://neo.example/chat/1");
    expect(resolveAuthRedirect("https://evil.example/", base)).toBe(base);
    expect(resolveAuthRedirect("//evil.example", base)).toBe(base);
  });
});

describe("databaseUrl precedence", () => {
  it("prefers NEO_DATABASE_URL over DATABASE_URL and falls back", async () => {
    const { databaseUrl, readEnv } = await import("@/lib/env");
    expect(databaseUrl({ NEO_DATABASE_URL: "postgres://app_user@h/neo", DATABASE_URL: "postgres://owner@h/neo" })).toBe(
      "postgres://app_user@h/neo",
    );
    expect(databaseUrl({ DATABASE_URL: "postgres://owner@h/neo" })).toBe("postgres://owner@h/neo");
    expect(databaseUrl({ NEO_DATABASE_URL: "  ", DATABASE_URL: "" })).toBeUndefined();
    expect(readEnv({ NEO_DATABASE_URL: "postgres://app_user@h/neo" }).DATABASE_URL).toBe("postgres://app_user@h/neo");
  });
});

describe("googleProfile", () => {
  it("maps email_verified into emailVerified and tolerates missing fields", () => {
    const verified = googleProfile({ sub: "g1", email: "a@example.com", email_verified: true, name: "A", picture: "p" });
    expect(verified).toMatchObject({ id: "g1", email: "a@example.com", name: "A", image: "p" });
    expect(verified.emailVerified).toBeInstanceOf(Date);
    expect(googleProfile({ sub: "g2", email_verified: false }).emailVerified).toBeNull();
    expect(googleProfile({ sub: "g3" })).toEqual({ id: "g3", name: null, email: null, image: null, emailVerified: null });
  });
});

describe("marketplace env fallbacks", () => {
  it("resolves the Resend key from RESEND_API_KEY, AUTH_RESEND_KEY, then MESSAGING_RESEND_API_KEY", () => {
    expect(resendApiKey({})).toBeUndefined();
    expect(resendApiKey({ MESSAGING_RESEND_API_KEY: "re_m" })).toBe("re_m");
    expect(resendApiKey({ AUTH_RESEND_KEY: "re_a", MESSAGING_RESEND_API_KEY: "re_m" })).toBe("re_a");
    expect(resendApiKey({ RESEND_API_KEY: "re_r", AUTH_RESEND_KEY: "re_a" })).toBe("re_r");
  });
  it("derives EMAIL_FROM from the integration's verified domain", () => {
    expect(emailFrom({})).toBe("Neo <neo@example.com>");
    expect(emailFrom({ MESSAGING_RESEND_EMAIL_DOMAIN: "Mail.Example.org" })).toBe("Neo <neo@mail.example.org>");
    expect(emailFrom({ EMAIL_FROM: "Neo <hi@x.test>", MESSAGING_RESEND_EMAIL_DOMAIN: "y.test" })).toBe("Neo <hi@x.test>");
  });
  it("treats an OIDC-connected Blob store as configured", () => {
    expect(hasBlobStore({})).toBe(false);
    expect(hasBlobStore({ BLOB_STORE_ID: "store_x" })).toBe(true);
    expect(hasBlobStore({ BLOB_READ_WRITE_TOKEN: "t" })).toBe(true);
  });
});
