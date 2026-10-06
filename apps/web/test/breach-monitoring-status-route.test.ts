// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/settings/breaches/route";

const state = vi.hoisted(() => ({ mode: "browser" as "browser" | "anonymous" | "desktop", tenantId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222", load: vi.fn() }));
vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return {
    ...actual,
    requireBrowserApiSession: async () => state.mode === "browser"
      ? { session: { tenantId: state.tenantId, userId: state.userId, role: "member" } }
      : { response: Response.json({ error: "sign in", code: state.mode === "desktop" ? "browser_session_required" : "unauthenticated" }, { status: state.mode === "desktop" ? 403 : 401 }) },
  };
});
vi.mock("@/lib/server/breach-monitoring/status-service", () => ({ getBreachStatusForUser: state.load }));

afterEach(() => vi.unstubAllEnvs());
beforeEach(() => {
  state.mode = "browser";
  state.load.mockReset().mockResolvedValue({ status: "clean", lastSuccessfulCheckAt: "2026-10-05T12:00:00.000Z", pendingCount: 0, addresses: [], attribution: { label: "Have I Been Pwned", license: "CC BY 4.0" } });
});

describe("breach status route", () => {
  it("returns a private status snapshot for the session member, ignoring query scope", async () => {
    const response = await GET(new Request(`http://localhost/api/settings/breaches?tenantId=other&userId=other`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ status: "clean" });
    expect(state.load).toHaveBeenCalledWith({ tenantId: state.tenantId, userId: state.userId });
  });

  it("rejects anonymous and desktop callers", async () => {
    state.mode = "anonymous";
    expect((await GET()).status).toBe(401);
    state.mode = "desktop";
    expect((await GET()).status).toBe(403);
    expect(state.load).not.toHaveBeenCalled();
  });
});
