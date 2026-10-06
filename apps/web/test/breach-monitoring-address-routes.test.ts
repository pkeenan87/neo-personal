// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/settings/breaches/addresses/route";
import { DELETE } from "@/app/api/settings/breaches/addresses/[id]/route";
import { POST as verify } from "@/app/api/settings/breaches/addresses/verify/route";
import { post, stubBaseEnv } from "./helpers/routes";

const state = vi.hoisted(() => ({
  authMode: "browser" as "browser" | "anonymous" | "desktop",
  tenantId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  service: null as null | Record<string, ReturnType<typeof vi.fn>>,
}));

vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return {
    ...actual,
    requireBrowserApiSession: async () => state.authMode === "browser"
      ? { session: { tenantId: state.tenantId, userId: state.userId, role: "member", email: "member@example.com", name: "Member", scopes: ["full"] } }
      : { response: Response.json({ error: state.authMode === "desktop" ? "browser required" : "sign in", code: state.authMode === "desktop" ? "browser_session_required" : "unauthenticated" }, { status: state.authMode === "desktop" ? 403 : 401 }) },
  };
});
vi.mock("@/lib/server/breach-monitoring/services", () => ({ getBreachAddressService: () => state.service }));

afterEach(() => vi.unstubAllEnvs());
beforeEach(() => {
  stubBaseEnv(vi);
  state.authMode = "browser";
  state.service = {
    listAddresses: vi.fn(async () => [{ id: "address-1", email: "member@example.com", source: "sign_in", verificationStatus: "verified", verifiedAt: "2026-10-01T00:00:00.000Z", checkStatus: "never_checked", lastCheckedAt: null, lastSuccessfulCheckAt: null }]),
    requestExtraAddress: vi.fn(async () => ({ status: "reserved" })),
    confirmAddress: vi.fn(async () => ({ verified: true })),
    removeAddress: vi.fn(async () => ({ removed: true })),
  };
});

describe("breach address settings routes", () => {
  it("lists the browser member's addresses with no-store headers", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ addresses: [{ email: "member@example.com" }] });
  });

  it("uses session tenant and user for add, ignoring spoofed identifiers", async () => {
    const response = await POST(post("/api/settings/breaches/addresses", { email: "extra@example.com", tenantId: "attacker", userId: "attacker" }));
    expect(response.status).toBe(202);
    expect(state.service?.requestExtraAddress).toHaveBeenCalledWith({ tenantId: state.tenantId, userId: state.userId, email: "extra@example.com" });
  });

  it("rejects malformed requests, anonymous callers, and desktop tokens", async () => {
    expect((await POST(post("/api/settings/breaches/addresses", { email: "bad" }))).status).toBe(400);
    state.authMode = "anonymous";
    expect((await GET()).status).toBe(401);
    state.authMode = "desktop";
    expect((await POST(post("/api/settings/breaches/addresses", { email: "extra@example.com" }))).status).toBe(403);
    expect(state.service?.requestExtraAddress).not.toHaveBeenCalled();
  });

  it("requires the authenticated browser session for confirmation and delete", async () => {
    const token = "A".repeat(43);
    expect((await verify(post("/api/settings/breaches/addresses/verify", { token, userId: "attacker" }))).status).toBe(200);
    expect(state.service?.confirmAddress).toHaveBeenCalledWith({ tenantId: state.tenantId, userId: state.userId, token });
    const response = await DELETE(new Request("http://localhost/api/settings/breaches/addresses/address-1", { method: "DELETE" }), { params: Promise.resolve({ id: "33333333-3333-4333-8333-333333333333" }) });
    expect(response.status).toBe(204);
    expect(state.service?.removeAddress).toHaveBeenCalledWith({ tenantId: state.tenantId, userId: state.userId, addressId: "33333333-3333-4333-8333-333333333333" });
  });
});
