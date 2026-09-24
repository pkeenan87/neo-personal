// @vitest-environment node
/**
 * The database path end to end on PGlite (in-process Postgres) with the
 * committed @neo/db migrations: dev identity bootstrap, the Auth.js session
 * callback and createUser event, the agent route persisting turns, usage,
 * verdicts and audit rows. PGlite runs as a superuser, so RLS itself is
 * covered by packages/db/test/rls.test.ts, not here.
 */
import { PGlite } from "@electric-sql/pglite";
import { auditEvents, schema, tenantScoped, turns, usageEvents, users, verdicts, type Db } from "@neo/db";
import { migrationsFolder } from "@neo/db/migrate";
import { MOCK_URLS } from "@neo/tools";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import type { AdapterUser } from "next-auth/adapters";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAuthConfig } from "@/auth";
import { POST as agentPOST } from "@/app/api/agent/route";
import { GET as usageGET } from "@/app/api/usage/route";
import { getSession } from "@/lib/session";
import { events, post, stubBaseEnv } from "./helpers/routes";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/server/db", () => ({ getDb: () => holder.db }));

let client: PGlite;
let db: Db;

beforeAll(async () => {
  client = new PGlite();
  const d = drizzle({ client, schema });
  await migrate(d, { migrationsFolder });
  db = d as unknown as Db;
  holder.db = db;
}, 60_000);

afterAll(async () => {
  await client.close();
});

beforeEach(() => {
  stubBaseEnv(vi);
});
afterEach(() => vi.unstubAllEnvs());

describe("with a database", () => {
  it("creates the dev user and household once under DEV_AUTH_BYPASS", async () => {
    const a = await getSession();
    const b = await getSession();
    expect(a).toMatchObject({ role: "owner", email: "dev@neo.local" });
    expect(b).toEqual(a);
    const rows = await db.select().from(users).where(eq(users.email, "dev@neo.local"));
    expect(rows).toHaveLength(1);
  });

  it("persists the turn, usage, verdict and cap-hit audit in Postgres", async () => {
    const session = (await getSession())!;
    const res = await agentPOST(post("/api/agent", { message: `check ${MOCK_URLS.phish}` }));
    expect(res.status).toBe(200);
    const id = res.headers.get("x-conversation-id")!;
    const evs = await events(res);
    expect(evs.some((e) => e.type === "tool_start" && e.name === "check_url")).toBe(true);
    expect(evs.at(-1)).toEqual({ type: "done", stop_reason: "end_turn" });

    const t = tenantScoped(db, session.tenantId);
    const turnRows = await t.select(turns, eq(turns.conversationId, id));
    expect(turnRows).toHaveLength(1);
    expect(turnRows[0]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    const usageRows = await t.select(usageEvents, eq(usageEvents.conversationId, id));
    expect(usageRows).toEqual([expect.objectContaining({ kind: "check", model: "mock" })]);
    expect(usageRows[0]!.inputTokens).toBeGreaterThan(0);
    const verdictRows = await t.select(verdicts, eq(verdicts.conversationId, id));
    expect(verdictRows).toEqual([expect.objectContaining({ verdict: "malicious", subjectType: "url", userId: session.userId })]);

    const usage = (await (await usageGET()).json()) as { monthlyChecks: { used: number } };
    expect(usage.monthlyChecks.used).toBe(1);

    vi.stubEnv("USAGE_CAP_MONTHLY_CHECKS", "1");
    for (let i = 0; i < 2; i++) expect((await agentPOST(post("/api/agent", { message: "again" }))).status).toBe(429);
    const hits = (await t.select(auditEvents)).filter((e) => e.eventType === "usage.cap_hit");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.metadata).toMatchObject({ reason: "monthly_checks", limit: 1 });
  });

  it("creates a household on first sign-in and returns { userId, tenantId, role } from the session callback", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://unused");
    const config = buildAuthConfig();
    const adapter = config.adapter!;
    const user = (await adapter.createUser!({
      id: crypto.randomUUID(),
      email: "new@example.test",
      emailVerified: null,
      name: "Nia Park",
    } as AdapterUser)) as AdapterUser;
    await config.events!.createUser!({ user });
    await config.events!.createUser!({ user }); // idempotent

    const session = (await config.callbacks!.session!({
      session: { user, expires: "2099-01-01T00:00:00Z", sessionToken: "t", userId: user.id },
      user,
    } as never)) as { userId: string; tenantId: string; role: string };
    expect(session).toMatchObject({ userId: user.id, role: "owner" });
    expect(session.tenantId).toMatch(/^[0-9a-f-]{36}$/);

    const created = (await tenantScoped(db, session.tenantId).select(auditEvents)).filter((e) => e.eventType === "tenant.created");
    expect(created).toHaveLength(1);
  });

  it("rejects Google sign-ins without a verified email", async () => {
    const config = buildAuthConfig();
    const signIn = config.callbacks!.signIn!;
    const google = { provider: "google", type: "oidc", providerAccountId: "1" };
    expect(await signIn({ account: google, profile: { email_verified: false }, user: {} } as never)).toBe(false);
    expect(await signIn({ account: google, profile: { email_verified: true }, user: {} } as never)).toBe(true);
  });
});
