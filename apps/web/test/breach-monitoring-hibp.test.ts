import { afterEach, describe, expect, it, vi } from "vitest";
import { lookupBreachedAccount } from "@/lib/server/breach-monitoring/hibp";

const KEY = "test-key-not-a-real-credential";
const source = {
  HIBP_API_KEY: KEY,
  HIBP_USER_AGENT: "Neo breach monitoring tests",
  HIBP_RPM: "10",
};
const breach = {
  Name: "Example Breach",
  Title: "Example Breach",
  Domain: "example.test",
  BreachDate: "2024-01-02",
  AddedDate: "2024-02-03T00:00:00Z",
  ModifiedDate: "2024-02-04T00:00:00Z",
  PwnCount: 123,
  Description: "Never store this description",
  LogoPath: "Example.png",
  DataClasses: ["Passwords", "Email addresses"],
  IsVerified: true,
  IsFabricated: false,
  IsSensitive: false,
  IsRetired: false,
  IsSpamList: false,
  IsMalware: false,
  IsStealerLog: false,
  IsSubscriptionFree: false,
};

afterEach(() => vi.unstubAllEnvs());

describe("lookupBreachedAccount", () => {
  it("sends an encoded address with full-response, API-key and User-Agent headers", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify([breach]), { status: 200 }));
    const result = await lookupBreachedAccount("  Mixed+tag@example.test ", { source, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://haveibeenpwned.com/api/v3/breachedaccount/Mixed%2Btag%40example.test?truncateResponse=false&IncludeUnverified=false");
    expect(new Headers(init?.headers).get("hibp-api-key")).toBe(KEY);
    expect(new Headers(init?.headers).get("user-agent")).toBe("Neo breach monitoring tests");
    expect(init?.method).toBe("GET");
    expect([...new Headers(init?.headers).keys()].sort()).toEqual(["hibp-api-key", "user-agent"]);
    expect(result).toEqual({ status: "breached", breaches: [{ name: "Example Breach", domain: "example.test", breachDate: "2024-01-02", addedDate: "2024-02-03T00:00:00Z", dataClasses: ["Passwords", "Email addresses"], retired: false }] });
    expect(JSON.stringify(result)).not.toContain("Never store this description");
  });

  it("returns clean for empty 200 and 404 responses", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("[]", { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(await lookupBreachedAccount("a@example.test", { source, fetchImpl })).toEqual({ status: "clean", breaches: [] });
    expect(await lookupBreachedAccount("a@example.test", { source, fetchImpl })).toEqual({ status: "clean", breaches: [] });
  });

  it("uses deterministic fixtures in mock mode and never calls the network", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const deps = { source: { MOCK_MODE: "true" }, fetchImpl };
    expect(await lookupBreachedAccount("alice@example.com", deps)).toMatchObject({ status: "breached", breaches: [{ name: expect.any(String) }] });
    expect(await lookupBreachedAccount("alice@example.net", deps)).toEqual({ status: "clean", breaches: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses the mock when no key is set outside a deployment, and never for a deployed key-less environment", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await lookupBreachedAccount("alice@example.com", { source: {}, fetchImpl })).toMatchObject({ status: "breached" });
    expect(await lookupBreachedAccount("alice@example.net", { source: {}, fetchImpl })).toEqual({ status: "clean", breaches: [] });
    expect(await lookupBreachedAccount("alice@example.com", { source: { VERCEL_ENV: "preview" }, fetchImpl })).toEqual({ status: "configuration_failure" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("calls the network with a key outside mock mode, even when not deployed", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }));
    await lookupBreachedAccount("alice@example.com", { source, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the live API key is missing and rejects malformed addresses", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await lookupBreachedAccount("a@example.test", { source: { VERCEL_ENV: "production" }, fetchImpl })).toEqual({ status: "configuration_failure" });
    expect(await lookupBreachedAccount("a@example.test", { source: { NODE_ENV: "production" }, fetchImpl })).toEqual({ status: "configuration_failure" });
    expect(await lookupBreachedAccount("not-an-email", { source, fetchImpl })).toEqual({ status: "invalid_request" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("classifies invalid input and provider-configuration responses without treating them as clean", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("bad request", { status: 400 }))
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
    expect(await lookupBreachedAccount("a@example.test", { source, fetchImpl })).toEqual({ status: "invalid_request" });
    expect(await lookupBreachedAccount("a@example.test", { source, fetchImpl })).toEqual({ status: "configuration_failure" });
    expect(await lookupBreachedAccount("a@example.test", { source, fetchImpl })).toEqual({ status: "configuration_failure" });
  });

  it("caps Retry-After to one hour and treats provider/network failures as retryable", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("rate limit", { status: 429, headers: { "Retry-After": "7200" } }))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockRejectedValueOnce(new Error("network down"));
    expect(await lookupBreachedAccount("a@example.test", { source, fetchImpl })).toEqual({ status: "retryable_failure", retryAfterSeconds: 3600 });
    expect(await lookupBreachedAccount("a@example.test", { source, fetchImpl })).toEqual({ status: "retryable_failure" });
    expect(await lookupBreachedAccount("a@example.test", { source, fetchImpl })).toEqual({ status: "retryable_failure" });
  });

  it("fails closed on incomplete, malformed or oversized full breach models", async () => {
    const partial = { Name: "Partial", DataClasses: [] };
    const invalidDate = { ...breach, BreachDate: "2024-02-31" };
    const badRetired = { ...breach, IsRetired: "no" };
    const oversized = { ...breach, Description: "x".repeat(1_100_000) };
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify([partial]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([invalidDate]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([badRetired]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([oversized]), { status: 200 }));
    for (let i = 0; i < 4; i++) expect(await lookupBreachedAccount("a@example.test", { source, fetchImpl })).toEqual({ status: "retryable_failure" });
  });

  it("accepts and ignores unknown or unused provider fields", async () => {
    const { Title, ModifiedDate, PwnCount, Description, LogoPath, ...used } = breach;
    void Title; void ModifiedDate; void PwnCount; void Description; void LogoPath;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify([{ ...used, NewField: { nested: true }, IsFutureFlag: true }]), { status: 200 }));
    const result = await lookupBreachedAccount("a@example.test", { source, fetchImpl });
    expect(result).toEqual({ status: "breached", breaches: [{ name: "Example Breach", domain: "example.test", breachDate: "2024-01-02", addedDate: "2024-02-03T00:00:00Z", dataClasses: ["Passwords", "Email addresses"], retired: false }] });
    expect(JSON.stringify(result)).not.toContain("NewField");
  });

  it("redacts email-like provider names before returning metadata", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify([{ ...breach, Name: "victim@example.test" }]), { status: 200 }));
    const result = await lookupBreachedAccount("a@example.test", { source, fetchImpl });
    expect(result).toMatchObject({ status: "breached", breaches: [{ name: expect.stringContaining("[redacted address]") }] });
    expect(JSON.stringify(result)).not.toContain("victim@example.test");
  });

  it("cancels a streaming provider body once the response-size bound is exceeded", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls <= 40) controller.enqueue(new Uint8Array(64 * 1024));
        else controller.close();
      },
      cancel() { cancelled = true; },
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 200 }));
    expect(await lookupBreachedAccount("a@example.test", { source, fetchImpl })).toEqual({ status: "retryable_failure" });
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(40);
  });

  it("does not call malformed 200 response clean", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("{\"unexpected\":true}", { status: 200 }));
    expect(await lookupBreachedAccount("a@example.test", { source, fetchImpl })).toEqual({ status: "retryable_failure" });
  });
});
