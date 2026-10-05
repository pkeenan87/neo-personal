// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/digest/unsubscribe/route";
import { setMemoryMembers } from "@/lib/server/memory-state";
import { createMemoryWeeklyDigestStore } from "@/lib/server/weekly-digest/store";
import { signDigestUnsubscribe } from "@/lib/server/weekly-digest/unsubscribe";
import { resetRateLimits } from "@/lib/server/rate-limit";
import { post, resetMemoryState, stubBaseEnv } from "./helpers/routes";
const owner = { tenantId: "11111111-1111-4111-8111-111111111111", userId: "owner" };
beforeEach(() => {
  stubBaseEnv(vi); vi.stubEnv("AUTH_SECRET", ""); resetMemoryState(); resetRateLimits();
  setMemoryMembers(owner.tenantId, [
    { userId: "owner", role: "owner", email: "owner@example.test", name: "Owner" },
    { userId: "other", role: "owner", email: "other@example.test", name: "Other" },
  ]);
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
it("keeps scanner GET read-only and confirms with an idempotent token-owner-only POST", async () => {
  const token = signDigestUnsubscribe(owner)!;
  const url = `https://neo.example.test/api/digest/unsubscribe?token=${token}`;
  const store = createMemoryWeeklyDigestStore();
  const confirmation = await GET(new Request(url));
  expect(confirmation.status).toBe(200);
  expect(confirmation.headers.get("cache-control")).toBe("no-store");
  expect(confirmation.headers.get("referrer-policy")).toBe("no-referrer");
  const html = await confirmation.text();
  expect(html).toContain('method="post"');
  expect(html).toContain("Unsubscribe");
  expect(html).not.toContain("owner@example.test");
  expect(await store.getPreference(owner.tenantId, owner.userId)).toBe(true);
  const res = await POST(post("/api/digest/unsubscribe", { token }));
  expect(res.status).toBe(204);
  expect(res.headers.get("location")).toBeNull();
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  expect(await store.getPreference(owner.tenantId, owner.userId)).toBe(false);
  expect(await store.getPreference(owner.tenantId, "other")).toBe(true);
  // RFC 8058 POST uses the token in the URL and this form body.
  expect((await POST(new Request(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" }))).status).toBe(204);
  expect((await POST(new Request("https://neo.example.test/api/digest/unsubscribe", { method: "POST", body: new URLSearchParams({ token }) }))).status).toBe(204);
  expect((await POST(post("/api/digest/unsubscribe", { token: token + "tampered" }))).status).toBe(400);
  setMemoryMembers(owner.tenantId, []);
  expect((await POST(post("/api/digest/unsubscribe", { token }))).status).toBe(204);
});

it("shares a 10/hour/IP budget across GET and POST, including invalid tokens", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-05T14:00:00Z"));
  const token = signDigestUnsubscribe(owner)!;
  const url = `https://neo.example.test/api/digest/unsubscribe?token=${token}`;
  const headers = { "x-forwarded-for": "192.0.2.1" };
  for (let i = 0; i < 9; i++) expect((await GET(new Request(url, { headers }))).status).toBe(200);
  expect((await POST(new Request(url + "bad", { method: "POST", headers }))).status).toBe(400);
  const denied = await POST(new Request(url, { method: "POST", headers }));
  expect(denied.status).toBe(429);
  expect(denied.headers.get("retry-after")).toBe("3600");
  expect(denied.headers.get("referrer-policy")).toBe("no-referrer");
  expect(await createMemoryWeeklyDigestStore().getPreference(owner.tenantId, owner.userId)).toBe(true);
  expect((await GET(new Request(url, { headers: { "x-forwarded-for": "192.0.2.2" } }))).status).toBe(200);
  vi.advanceTimersByTime(3600000);
  expect((await POST(new Request(url, { method: "POST", headers }))).status).toBe(204);
});
