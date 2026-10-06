// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/hardening-score/route";
import { POST } from "@/app/api/hardening-score/answers/route";
import {
  clearAccountHardeningAnswer,
  HardeningScoreError,
  loadAccountHardeningScore,
  loadHouseholdHardeningPercents,
  setAccountHardeningAnswer,
} from "@/lib/server/hardening-score";
import { memoryCreateDesktopToken } from "@/lib/server/memory-desktop-tokens";
import { memoryLeave } from "@/lib/server/memory-household";
import { memoryState, setMemoryMembers } from "@/lib/server/memory-state";
import { DEV_SESSION_IDS, type NeoSession } from "@/lib/session";
import { post, resetMemoryState, stubBaseEnv } from "./helpers/routes";

const hdrs = vi.hoisted(() => ({ current: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => hdrs.current, cookies: async () => ({ get: () => undefined, getAll: () => [] }) }));
// A store whose every call fails, to prove errors surface as 503 instead of a cached score.
const store = vi.hoisted(() => ({ failing: false }));
vi.mock("@/lib/server/memory-hardening", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/server/memory-hardening")>();
  return {
    ...actual,
    createMemoryHardeningStore: () => store.failing
      ? new Proxy({}, { get: () => async () => { throw new Error("db down"); } }) as ReturnType<typeof actual.createMemoryHardeningStore>
      : actual.createMemoryHardeningStore(),
  };
});

const V1 = "account-hardening-v1";
const { tenantId, userId } = DEV_SESSION_IDS;
const owner: NeoSession = { tenantId, userId, role: "owner", email: "o@example.test", name: "Owner", scopes: ["full"] };
const member: NeoSession = { tenantId, userId: "member-1", role: "member", email: "m@example.test", name: "Member", scopes: ["full"] };
const answer = (itemId: string, value: unknown, checklistVersion: unknown = V1) => post("/api/hardening-score/answers", { itemId, checklistVersion, value });
const stateOf = (score: { items: Array<{ id: string; state: string }> }, id: string) => score.items.find(i => i.id === id)?.state;

beforeEach(() => {
  stubBaseEnv(vi);
  resetMemoryState();
  hdrs.current = new Headers();
  store.failing = false;
  setMemoryMembers(tenantId, [
    { userId, role: "owner", email: "o@example.test", name: "Owner" },
    { userId: "member-1", role: "member", email: "m@example.test", name: "Member" },
  ]);
});
afterEach(() => vi.unstubAllEnvs());

describe("GET /api/hardening-score", () => {
  it("returns the session user's score with no-store and ignores a userId selector", async () => {
    await setAccountHardeningAnswer(member, { itemId: "password_manager", checklistVersion: V1, value: true });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.checklistVersion).toBe(V1);
    expect(body.scorePercent).toBeNull();
    expect(stateOf(body, "password_manager")).toBe("unanswered"); // the owner's own checklist, not the member's
    expect(body.items).toHaveLength(10);
  });

  it("returns 503 storage_unavailable when the store fails, never a cached score", async () => {
    store.failing = true;
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "storage_unavailable" });
  });
});

describe("POST /api/hardening-score/answers", () => {
  it("sets, re-answers, and clears an answer; server sets answeredAt", async () => {
    const res = await POST(answer("primary_email_2fa", true));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const set = await res.json();
    expect(stateOf(set, "primary_email_2fa")).toBe("complete");
    expect(Math.abs(Date.parse(set.items.find((i: { id: string }) => i.id === "primary_email_2fa").answeredAt) - Date.now())).toBeLessThan(5000);
    expect(stateOf(await (await POST(answer("primary_email_2fa", false))).json(), "primary_email_2fa")).toBe("needs_action");
    expect(stateOf(await (await POST(answer("primary_email_2fa", "clear"))).json(), "primary_email_2fa")).toBe("unanswered");
    expect(stateOf(await (await POST(answer("credit_freeze", "not_applicable"))).json(), "credit_freeze")).toBe("not_applicable");
  });

  it("rejects invalid items, values, extra keys and non-answerable combinations with 400", async () => {
    for (const [itemId, value] of [["nope", true], ["primary_email_2fa", "yes"], ["primary_email_2fa", "not_applicable"], ["forwarding_used_30d", true],
      ["desktop_agent_enrolled", true], ["password_manager", null], [7, true]] as const) {
      expect((await POST(answer(itemId as string, value))).status, `${itemId}=${String(value)}`).toBe(400);
    }
    expect((await POST(post("/api/hardening-score/answers", { itemId: "password_manager", checklistVersion: V1, value: true, userId: "x" }))).status).toBe(400);
    expect((await POST(post("/api/hardening-score/answers", { itemId: "password_manager", value: true }))).status).toBe(400);
    expect((await POST(new Request("http://localhost/api/hardening-score/answers", { method: "POST", body: "not json" }))).status).toBe(400);
    expect((await (await GET()).json()).items.every((i: { answeredAt: string | null }) => i.answeredAt === null)).toBe(true);
  });

  it("returns 409 checklist_version_mismatch without mutating", async () => {
    await POST(answer("password_manager", true));
    for (const value of [false, "clear"]) {
      const res = await POST(answer("password_manager", value, "account-hardening-v0"));
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "checklist_version_mismatch" });
    }
    expect(stateOf(await (await GET()).json(), "password_manager")).toBe("complete");
  });

  it("is browser-only: a full desktop token can read but not mutate", async () => {
    vi.stubEnv("DEV_AUTH_BYPASS", "false");
    const minted = memoryCreateDesktopToken({ userId, tenantId, role: "owner", name: "Omarchy bar" });
    if ("error" in minted) throw new Error(minted.error);
    hdrs.current = new Headers({ authorization: `Bearer ${minted.token}` });
    expect((await GET()).status).toBe(200);
    const res = await POST(answer("password_manager", true));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "browser_session_required" });
    hdrs.current = new Headers();
    vi.stubEnv("DEV_AUTH_BYPASS", "true");
    expect(stateOf(await (await GET()).json(), "password_manager")).toBe("unanswered");
  });

  it("returns 403 forbidden, not 503, when the session user has no membership row", async () => {
    setMemoryMembers(tenantId, [{ userId: "someone-else", role: "owner", email: "x@example.test", name: "X" }]);
    const res = await POST(answer("password_manager", true));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "forbidden" });
  });

  it("returns 503 storage_unavailable when the write fails", async () => {
    store.failing = true;
    const res = await POST(answer("password_manager", true));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "storage_unavailable" });
  });
});

describe("score service (in-memory twin)", () => {
  it("shows not enough answers until three self-attested items are answered", async () => {
    await setAccountHardeningAnswer(owner, { itemId: "primary_email_2fa", checklistVersion: V1, value: true });
    await setAccountHardeningAnswer(owner, { itemId: "passkey_or_hardware_key", checklistVersion: V1, value: true });
    expect((await loadAccountHardeningScore(owner)).scorePercent).toBeNull();
    const score = await setAccountHardeningAnswer(owner, { itemId: "password_manager", checklistVersion: V1, value: false });
    expect(score.scorePercent).toBe(30);
    expect(score.nextActions).toEqual(["password_manager", "carrier_port_out_pin", "credit_freeze"]);
  });

  it("marks an answer stale at exactly 180 days", async () => {
    await setAccountHardeningAnswer(owner, { itemId: "password_manager", checklistVersion: V1, value: true });
    const row = memoryState().hardeningAnswers.get(`${tenantId}:${userId}:password_manager`)!;
    const now = new Date();
    row.answeredAt = new Date(+now - 180 * 24 * 3600_000);
    expect(stateOf(await loadAccountHardeningScore(owner, now), "password_manager")).toBe("stale");
    row.answeredAt = new Date(+now - 180 * 24 * 3600_000 + 1000);
    expect(stateOf(await loadAccountHardeningScore(owner, now), "password_manager")).toBe("complete");
  });

  it("derives forwarding from this user's attributed messages in the rolling 30 days", async () => {
    const now = new Date("2026-10-05T12:00:00Z");
    const msg = (forwarderUserId: string | null, receivedAt: Date) => ({ tenantId, forwarderUserId, receivedAt }) as never;
    memoryState().inboundMessages.push(msg(null, now), msg("member-1", now), msg(userId, new Date(+now - 30 * 24 * 3600_000)));
    expect(stateOf(await loadAccountHardeningScore(owner, now), "forwarding_used_30d")).toBe("needs_action");
    memoryState().inboundMessages.push({ tenantId, forwarderUserId: userId, receivedAt: new Date(+now - 24 * 3600_000), status: "rejected" } as never);
    expect(stateOf(await loadAccountHardeningScore(owner, now), "forwarding_used_30d")).toBe("needs_action");
    memoryState().inboundMessages.push(msg(userId, new Date(+now - 29 * 24 * 3600_000)));
    expect(stateOf(await loadAccountHardeningScore(owner, now), "forwarding_used_30d")).toBe("complete");
    expect(stateOf(await loadAccountHardeningScore(owner, new Date(+now + 2 * 24 * 3600_000)), "forwarding_used_30d")).toBe("needs_action");
    // The member's own attributed forward counts for the member only.
    expect(stateOf(await loadAccountHardeningScore(member, now), "forwarding_used_30d")).toBe("complete");
  });

  it("deletes a member's answers when they leave the household", async () => {
    await setAccountHardeningAnswer(member, { itemId: "password_manager", checklistVersion: V1, value: true });
    expect(stateOf(await loadAccountHardeningScore(member), "password_manager")).toBe("complete");
    expect(memoryLeave(tenantId, "member-1").status).toBe("left");
    expect(stateOf(await loadAccountHardeningScore(member), "password_manager")).toBe("unanswered");
  });

  it("clears an answer through the service", async () => {
    await setAccountHardeningAnswer(owner, { itemId: "credit_freeze", checklistVersion: V1, value: true });
    expect(stateOf(await clearAccountHardeningAnswer(owner, "credit_freeze"), "credit_freeze")).toBe("unanswered");
  });
});

describe("loadHouseholdHardeningPercents", () => {
  it("is owner only: a member gets 403", async () => {
    const err = await loadHouseholdHardeningPercents(member).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HardeningScoreError);
    expect(err).toMatchObject({ status: 403, code: "forbidden" });
  });

  it("serializes only userId and scorePercent for each member, with no item or answer fields", async () => {
    for (const id of ["primary_email_2fa", "passkey_or_hardware_key", "password_manager"] as const) {
      await setAccountHardeningAnswer(member, { itemId: id, checklistVersion: V1, value: id !== "password_manager" });
    }
    const percents = await loadHouseholdHardeningPercents(owner);
    expect(percents).toEqual([{ userId, scorePercent: null }, { userId: "member-1", scorePercent: 30 }]);
    for (const p of percents) expect(Object.keys(p).sort()).toEqual(["scorePercent", "userId"]);
    expect(JSON.stringify(percents)).not.toMatch(/items|state|answer|partial|nextActions|incomplete|open/i);
  });

  it("returns 503-class errors on storage failure", async () => {
    store.failing = true;
    await expect(loadHouseholdHardeningPercents(owner)).rejects.toMatchObject({ status: 503, code: "storage_unavailable" });
  });
});
