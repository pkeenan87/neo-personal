// @vitest-environment node
/** The per-household monthly model spend cap (_specs/v2-m3-cutover.md section 6), on the no-database path. */
import type { Session } from "next-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gateTurn } from "@/agent/lib/usage-gate";
import { POST as agentPOST } from "@/app/api/agent/route";
import { GET as spendGET, PUT as spendPUT } from "@/app/api/household/spend-cap/route";
import { memoryAuditLog } from "@/lib/server/audit";
import { memoryAlertRows, resetMemoryAlerts } from "@/lib/server/memory-alerts";
import { memorySetHouseholdTimeZone } from "@/lib/server/memory-members";
import { setMemoryMembers } from "@/lib/server/memory-state";
import { evaluateSpendCap, setSpendCapCents, spendGate, spendView } from "@/lib/server/spend-cap";
import { checkCaps, recordUsage } from "@/lib/server/usage";
import { post, resetMemoryState, stubBaseEnv } from "./helpers/routes";

const authState = vi.hoisted(() => ({ session: null as Session | null }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => authState.session) }));

const TENANT = "00000000-0000-4000-8000-0000000000aa";
const OTHER = "00000000-0000-4000-8000-0000000000bb";
const OWNER = "owner-a";
const MEMBER = "member-a";
/** Opus 5 lists $25 per million output tokens: 100,000 output tokens = $2.50 = 250 cents. */
const MODEL = "anthropic/claude-opus-5";
const CAP = 1000; // $10

function signIn(userId: string, tenantId: string, role: "owner" | "member"): void {
  vi.stubEnv("DEV_AUTH_BYPASS", "false");
  authState.session = { userId, tenantId, role, user: { email: `${userId}@example.test`, name: userId }, expires: "2099-01-01T00:00:00Z" } as Session;
}

/** Spend `cents` (a multiple of 2.5) on Opus output tokens. */
async function spend(cents: number, tenantId = TENANT): Promise<void> {
  await recordUsage({ tenantId, userId: OWNER, model: MODEL, inputTokens: 0, outputTokens: Math.round((cents / 2500) * 1_000_000) });
}

const alertsOf = (tenantId = TENANT) => memoryAlertRows().filter((a) => a.tenantId === tenantId && a.kind === "spend_cap");

beforeEach(() => {
  stubBaseEnv(vi);
  resetMemoryState();
  resetMemoryAlerts();
  authState.session = null;
  vi.stubEnv("USAGE_CAP_DAILY_TOKENS", "100000000");
  setMemoryMembers(TENANT, [
    { userId: OWNER, role: "owner", name: "Owner", email: "owner@example.test" },
    { userId: MEMBER, role: "member", name: "Member", email: "member@example.test" },
  ]);
  setMemoryMembers(OTHER, [{ userId: "owner-b", role: "owner", name: "Owner B", email: "b@example.test" }]);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  memorySetHouseholdTimeZone(TENANT, null);
});

describe("cap off (the default)", () => {
  it("changes nothing: no alert, no refusal, no spend query result", async () => {
    await spend(5000);
    expect(await evaluateSpendCap(TENANT)).toBeNull();
    expect(await spendGate(TENANT)).toEqual({ blocked: false });
    expect(await gateTurn({ tenantId: TENANT, userId: OWNER })).toEqual({ ok: true });
    expect(alertsOf()).toHaveLength(0);
    expect((await spendView(TENANT)).capCents).toBeNull();
  });
});

describe("thresholds", () => {
  it("79% raises nothing and allows chat", async () => {
    await setSpendCapCents(TENANT, CAP);
    await spend(790);
    expect(alertsOf()).toHaveLength(0);
    expect(await gateTurn({ tenantId: TENANT, userId: OWNER })).toEqual({ ok: true });
  });

  it("80% raises one medium alert to the owners, once however often it is checked, and still allows chat", async () => {
    await setSpendCapCents(TENANT, CAP);
    await spend(800);
    await evaluateSpendCap(TENANT);
    await gateTurn({ tenantId: TENANT, userId: OWNER });
    const rows = alertsOf();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "spend_cap", severity: "medium", subjectUserId: null });
    expect(rows[0]!.dedupeKey).toMatch(new RegExp(`^spend_cap:${TENANT}:\\d{4}-\\d{2}:80$`));
    expect(rows[0]!.title).toContain("80%");
    expect(await gateTurn({ tenantId: TENANT, userId: OWNER })).toEqual({ ok: true });
  });

  it("100% raises one high alert (after the 80% one) and refuses in the eve chat with a templated message", async () => {
    await setSpendCapCents(TENANT, CAP);
    await spend(800);
    await spend(250);
    const gate = await gateTurn({ tenantId: TENANT, userId: OWNER });
    await gateTurn({ tenantId: TENANT, userId: OWNER });
    expect(gate).toMatchObject({ ok: false });
    expect((gate as { text: string }).text).toContain("monthly AI spend limit");
    const rows = alertsOf();
    expect(rows.map((a) => a.severity).sort()).toEqual(["high", "medium"]);
    expect(rows.find((a) => a.severity === "high")!.dedupeKey).toMatch(/:100$/);
  });

  it("100% refuses the old chat with a 429 and does not run the agent", async () => {
    await setSpendCapCents(TENANT, CAP);
    await spend(1000);
    signIn(OWNER, TENANT, "owner");
    const res = await agentPOST(post("/api/agent", { message: "hello" }));
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string; limitCents: number; message: string };
    expect(body).toMatchObject({ error: "spend_cap_exceeded", limitCents: CAP });
    expect(body.message).toContain("monthly AI spend limit");
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    // The daily/monthly check caps are separate and untouched.
    expect((await checkCaps(TENANT)).allowed).toBe(true);
  });

  it("does not block another household", async () => {
    await setSpendCapCents(TENANT, CAP);
    await spend(1000);
    expect(await spendGate(OTHER)).toEqual({ blocked: false });
    expect(alertsOf(OTHER)).toHaveLength(0);
  });
});

describe("month boundary in the household time zone", () => {
  it("counts the month in the household time zone and keys the alert by it", async () => {
    memorySetHouseholdTimeZone(TENANT, "Pacific/Auckland");
    await setSpendCapCents(TENANT, CAP);
    // 2026-11-30T12:00Z is already 2026-12-01 01:00 in Auckland (UTC+13).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-30T12:00:00Z"));
    await spend(900);
    const nov = await spendView(TENANT);
    expect(nov.month).toBe("2026-12");
    expect(nov.spentCents).toBeCloseTo(900, 5);
    expect(nov.resetAt.toISOString()).toBe("2026-12-31T11:00:00.000Z");
    // Next Auckland month: the spend counter has started again from zero.
    vi.setSystemTime(new Date("2026-12-31T12:00:00Z"));
    const jan = await spendView(TENANT);
    expect(jan.month).toBe("2027-01");
    expect(jan.spentCents).toBe(0);
    expect(await spendGate(TENANT)).toEqual({ blocked: false });
  });
});

describe("settings route", () => {
  it("lets the owner turn it on, read the spend and turn it off, with audit events", async () => {
    signIn(OWNER, TENANT, "owner");
    expect(await (await spendGET()).json()).toMatchObject({ capCents: null, spentCents: 0, percent: null });
    await spend(500);
    const put = await spendPUT(new Request("http://localhost/api/household/spend-cap", { method: "PUT", body: JSON.stringify({ capCents: 2000 }) }));
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ capCents: 2000, spentCents: 500, percent: 25 });
    await spendPUT(new Request("http://localhost/api/household/spend-cap", { method: "PUT", body: JSON.stringify({ capCents: null }) }));
    expect((await spendView(TENANT)).capCents).toBeNull();
    const audits = memoryAuditLog().filter((e) => e.eventType === "household.spend_cap_changed");
    expect(audits.map((e) => e.metadata)).toEqual([
      { from: null, to: 2000 },
      { from: 2000, to: null },
    ]);
  });

  it("rejects out-of-range and malformed values", async () => {
    signIn(OWNER, TENANT, "owner");
    for (const capCents of [99, 1_000_001, 12.5]) {
      const res = await spendPUT(new Request("http://localhost/api/household/spend-cap", { method: "PUT", body: JSON.stringify({ capCents }) }));
      expect(res.status).toBe(400);
    }
    const bad = await spendPUT(new Request("http://localhost/api/household/spend-cap", { method: "PUT", body: JSON.stringify({ capCents: "10" }) }));
    expect(bad.status).toBe(400);
    expect((await spendView(TENANT)).capCents).toBeNull();
  });

  it("refuses a member, whatever the role they claim", async () => {
    signIn(MEMBER, TENANT, "owner");
    expect((await spendGET()).status).toBe(403);
    const res = await spendPUT(new Request("http://localhost/api/household/spend-cap", { method: "PUT", body: JSON.stringify({ capCents: 500 }) }));
    expect(res.status).toBe(403);
    expect((await spendView(TENANT)).capCents).toBeNull();
  });

  it("acts only on the session's own household", async () => {
    signIn("owner-b", OTHER, "owner");
    const res = await spendPUT(new Request("http://localhost/api/household/spend-cap", { method: "PUT", body: JSON.stringify({ capCents: 500 }) }));
    expect(res.status).toBe(200);
    expect((await spendView(OTHER)).capCents).toBe(500);
    expect((await spendView(TENANT)).capCents).toBeNull();
  });

  it("requires a session", async () => {
    expect([401, 403]).toContain((await spendGET()).status);
  });
});
