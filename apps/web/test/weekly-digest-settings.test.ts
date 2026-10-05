// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/settings/digest/route";
import { setMemoryMembers } from "@/lib/server/memory-state";
import { createMemoryWeeklyDigestStore } from "@/lib/server/weekly-digest/store";
import { post, resetMemoryState, stubBaseEnv } from "./helpers/routes";

const identity = vi.hoisted(() => ({ tenantId: "11111111-1111-4111-8111-111111111111", userId: "owner", role: "owner" as const }));
const auth = vi.hoisted(() => ({ signedIn: true }));
vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  const resolve = async () => auth.signedIn ? { session: identity } : { response: new Response(null, { status: 401 }) };
  return { ...actual, requireApiSession: resolve, requireBrowserApiSession: resolve };
});
beforeEach(() => {
  stubBaseEnv(vi); resetMemoryState(); auth.signedIn = true;
  setMemoryMembers(identity.tenantId, [
    { userId: "owner", role: "owner", email: "owner@example.test", name: "Owner" },
    { userId: "member", role: "member", email: "member@example.test", name: "Member" },
  ]);
});
afterEach(() => vi.unstubAllEnvs());

it("reads and changes only the session user's live preference", async () => {
  const res = await GET();
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(await res.json()).toEqual({ enabled: true });
  expect((await POST(post("/api/settings/digest", { enabled: true, userId: "member" }))).status).toBe(400);
  expect((await POST(post("/api/settings/digest", { enabled: "false" }))).status).toBe(400);
  expect(await (await POST(post("/api/settings/digest", { enabled: false }))).json()).toEqual({ enabled: false });
  expect(await (await GET()).json()).toEqual({ enabled: false });
  expect(await createMemoryWeeklyDigestStore().getPreference(identity.tenantId, "member")).toBe(false);
  setMemoryMembers(identity.tenantId, []);
  expect((await GET()).status).toBe(403);
  expect((await POST(post("/api/settings/digest", { enabled: true }))).status).toBe(403);
  auth.signedIn = false;
  expect((await GET()).status).toBe(401);
  expect((await POST(post("/api/settings/digest", { enabled: true }))).status).toBe(401);
});
