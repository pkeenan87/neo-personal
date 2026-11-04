// @vitest-environment node
/** Per-household retention settings route (_specs/v2-m4-hardening.md section 1), on the no-database path. */
import type { Session } from "next-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RETENTION } from "@neo/core";
import { GET, PUT } from "@/app/api/household/retention/route";
import { memoryAuditLog } from "@/lib/server/audit";
import { setMemoryMembers } from "@/lib/server/memory-state";
import { effectiveRetentionFor } from "@/lib/server/retention-settings";
import { resetMemoryState, stubBaseEnv } from "./helpers/routes";

const authState = vi.hoisted(() => ({ session: null as Session | null }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => authState.session) }));

const TENANT = "00000000-0000-4000-8000-0000000000aa";
const OTHER = "00000000-0000-4000-8000-0000000000bb";
const OWNER = "owner-a";
const MEMBER = "member-a";
const VALID = { signals: 14, incidents: 400, childRequests: 30, memory: 200 };

function signIn(userId: string, tenantId: string, role: "owner" | "member"): void {
  vi.stubEnv("DEV_AUTH_BYPASS", "false");
  authState.session = { userId, tenantId, role, user: { email: `${userId}@example.test`, name: userId }, expires: "2099-01-01T00:00:00Z" } as Session;
}

const put = (body: unknown) => PUT(new Request("http://localhost/api/household/retention", { method: "PUT", body: JSON.stringify(body) }));

beforeEach(() => {
  stubBaseEnv(vi);
  resetMemoryState();
  (globalThis as { __neoMemoryRetention?: unknown }).__neoMemoryRetention = undefined;
  authState.session = null;
  setMemoryMembers(TENANT, [
    { userId: OWNER, role: "owner", name: "Owner", email: "owner@example.test" },
    { userId: MEMBER, role: "member", name: "Member", email: "member@example.test" },
  ]);
  setMemoryMembers(OTHER, [{ userId: "owner-b", role: "owner", name: "Owner B", email: "b@example.test" }]);
});
afterEach(() => vi.unstubAllEnvs());

describe("retention settings route", () => {
  it("shows the defaults and the bounds to the owner", async () => {
    signIn(OWNER, TENANT, "owner");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ settings: DEFAULT_RETENTION, bounds: { signals: { min: 7, max: 365 }, incidents: { min: 30, max: 1095 }, childRequests: { min: 7, max: 365 }, memory: { min: 30, max: 1095 } } });
  });

  it("saves in-range values and audits the change once", async () => {
    signIn(OWNER, TENANT, "owner");
    const res = await put(VALID);
    expect(res.status).toBe(200);
    expect((await res.json()).settings).toEqual(VALID);
    expect(await effectiveRetentionFor(TENANT)).toEqual(VALID);
    await put(VALID); // unchanged: no second event
    const audits = memoryAuditLog().filter((e) => e.eventType === "household.retention_changed");
    expect(audits.map((e) => e.metadata)).toEqual([{ from: DEFAULT_RETENTION, to: VALID }]);
  });

  it("rejects out-of-range, non-integer, missing and unknown values with 400 and the fields", async () => {
    signIn(OWNER, TENANT, "owner");
    for (const bad of [{ ...VALID, signals: 6 }, { ...VALID, signals: 366 }, { ...VALID, incidents: 29 }, { ...VALID, incidents: 1096 }, { ...VALID, childRequests: 6 }, { ...VALID, memory: 1096 }, { ...VALID, memory: 40.5 }, { ...VALID, memory: "40" }]) {
      expect((await put(bad)).status).toBe(400);
    }
    const missing = await put({ signals: 14 });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { fields: { path: string }[] }).fields.map((f) => f.path)).toEqual(["incidents", "childRequests", "memory"]);
    expect((await put({ ...VALID, extra: 1 })).status).toBe(400);
    expect(await effectiveRetentionFor(TENANT)).toEqual(DEFAULT_RETENTION);
  });

  it("accepts the bounds themselves", async () => {
    signIn(OWNER, TENANT, "owner");
    expect((await put({ signals: 7, incidents: 30, childRequests: 7, memory: 30 })).status).toBe(200);
    expect((await put({ signals: 365, incidents: 1095, childRequests: 365, memory: 1095 })).status).toBe(200);
  });

  it("refuses a member, whatever the role they claim", async () => {
    signIn(MEMBER, TENANT, "owner");
    expect((await GET()).status).toBe(403);
    expect((await put(VALID)).status).toBe(403);
    expect(await effectiveRetentionFor(TENANT)).toEqual(DEFAULT_RETENTION);
  });

  it("acts only on the session's own household", async () => {
    signIn("owner-b", OTHER, "owner");
    expect((await put(VALID)).status).toBe(200);
    expect(await effectiveRetentionFor(OTHER)).toEqual(VALID);
    expect(await effectiveRetentionFor(TENANT)).toEqual(DEFAULT_RETENTION);
  });

  it("requires a session", async () => {
    expect([401, 403]).toContain((await GET()).status);
  });
});
