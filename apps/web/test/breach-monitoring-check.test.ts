import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressRow, BreachObservationRow } from "@neo/db";
import { encryptMonitoredAddress, deriveGlobalBreachQueryDigest } from "@/lib/server/breach-monitoring/crypto";
import { createBreachCheckService, type BreachCheckStore } from "@/lib/server/breach-monitoring/check-service";
import type { HIBPResult } from "@/lib/server/breach-monitoring/hibp";

const MASTER = Buffer.alloc(32, 19).toString("base64");
const SOURCE = { NEO_MASTER_KEY: MASTER };
const NOW = new Date("2026-10-05T12:00:00.000Z");
const EMAIL = "shared@example.com";
const TARGETS = [
  { tenantId: "11111111-1111-4111-8111-111111111111", userId: "member-a", addressId: "33333333-3333-4333-8333-333333333333" },
  { tenantId: "44444444-4444-4444-8444-444444444444", userId: "member-b", addressId: "55555555-5555-4555-8555-555555555555" },
];

afterEach(() => vi.restoreAllMocks());
function makeAddress(target: typeof TARGETS[number], email = EMAIL): AddressRow {
  return {
    id: target.addressId,
    tenantId: target.tenantId,
    userId: target.userId,
    digest: "0".repeat(64),
    encryptedAddress: encryptMonitoredAddress(email, target, SOURCE),
    verificationSource: "extra",
    verificationPending: false,
    verifiedAt: NOW,
    verificationTokenHash: undefined,
    verificationExpiresAt: undefined,
    checkStatus: "never_checked",
    lastCheckedAt: undefined,
    lastSuccessfulCheckAt: undefined,
    createdAt: NOW,
    updatedAt: NOW,
  };
}
function observation(input: { tenantId: string; addressId: string; breachName: string; dataClasses: string[]; domain?: string; breachDate?: Date; addedDate?: Date; retiredAt?: Date }): BreachObservationRow {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    tenantId: input.tenantId,
    monitoredAddressId: input.addressId,
    breachName: input.breachName,
    domain: input.domain,
    breachDate: input.breachDate,
    addedDate: input.addedDate,
    dataClasses: input.dataClasses,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    retiredAt: input.retiredAt,
  };
}
function makeStore(addresses: AddressRow[]): { store: BreachCheckStore; upserts: unknown[]; updates: unknown[] } {
  const upserts: unknown[] = [];
  const updates: unknown[] = [];
  const store: BreachCheckStore = {
    getAddressForCheck: vi.fn(async (target) => addresses.find((row) => row.tenantId === target.tenantId && row.userId === target.userId && row.id === target.addressId)),
    updateCheck: vi.fn(async (input) => { updates.push(input); return true; }),
    upsertObservations: vi.fn(async (input: Parameters<BreachCheckStore["upsertObservations"]>[0]) => {
      upserts.push(input);
      return { newObservations: input.observations.filter((row) => !row.retiredAt).map((row) => observation({ tenantId: input.tenantId, addressId: input.addressId, ...row })) };
    }),
  };
  return { store, upserts, updates };
}

describe("breach check service", () => {
  it("dedupes one in-flight HIBP query across tenants and fans observations/alerts back per tenant", async () => {
    const rows = TARGETS.map((target) => makeAddress(target));
    const { store, upserts, updates } = makeStore(rows);
    let finish!: (result: HIBPResult) => void;
    const lookup = vi.fn(() => new Promise<HIBPResult>((resolve) => { finish = resolve; }));
    const alerts: unknown[] = [];
    const service = createBreachCheckService({ store, source: SOURCE, now: () => NOW, lookup, raiseAlert: async (input) => { alerts.push(input); } });
    const first = service.check(TARGETS[0]!);
    const second = service.check(TARGETS[1]!);
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(1));
    expect(lookup).toHaveBeenCalledWith(EMAIL);
    expect(await deriveGlobalBreachQueryDigest(EMAIL, SOURCE)).toHaveLength(64);
    finish({ status: "breached", breaches: [{ name: "Example Breach", domain: "example.com", breachDate: "2024-01-02", addedDate: "2024-02-03T00:00:00Z", dataClasses: ["Passwords"], retired: false }] });
    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.status)).toEqual(["breached", "breached"]);
    expect(upserts).toHaveLength(2);
    expect(upserts).toEqual(expect.arrayContaining([
      expect.objectContaining({ tenantId: TARGETS[0]!.tenantId, userId: TARGETS[0]!.userId, addressId: TARGETS[0]!.addressId }),
      expect.objectContaining({ tenantId: TARGETS[1]!.tenantId, userId: TARGETS[1]!.userId, addressId: TARGETS[1]!.addressId }),
    ]));
    expect(updates).toHaveLength(2);
    expect(alerts).toHaveLength(2);
    expect(alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({ tenantId: TARGETS[0]!.tenantId, userId: TARGETS[0]!.userId, addressId: TARGETS[0]!.addressId, breachName: "Example Breach", dataClasses: ["Passwords"] }),
      expect.objectContaining({ tenantId: TARGETS[1]!.tenantId, userId: TARGETS[1]!.userId, addressId: TARGETS[1]!.addressId, breachName: "Example Breach", dataClasses: ["Passwords"] }),
    ]));
    expect(JSON.stringify(results)).not.toContain(EMAIL);
  });

  it("rechecks address eligibility immediately before provider access", async () => {
    const { store, updates } = makeStore([]);
    const lookup = vi.fn(async (): Promise<HIBPResult> => ({ status: "clean", breaches: [] }));
    const service = createBreachCheckService({ store, source: SOURCE, lookup, raiseAlert: vi.fn() });
    expect(await service.check(TARGETS[0]!)).toMatchObject({ status: "skipped" });
    expect(lookup).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it("records provider/configuration failures as failed, never clean", async () => {
    const { store, updates, upserts } = makeStore([makeAddress(TARGETS[0]!)]);
    const lookup = vi.fn(async (): Promise<HIBPResult> => ({ status: "configuration_failure" }));
    const service = createBreachCheckService({ store, source: SOURCE, now: () => NOW, lookup, raiseAlert: vi.fn() });
    expect(await service.check(TARGETS[0]!)).toMatchObject({ status: "failed" });
    expect(upserts).toEqual([]);
    expect(updates).toEqual([expect.objectContaining({ status: "failed", checkedAt: NOW })]);
  });

  it("caps retry delay at one hour and retains retired observations without alerting", async () => {
    const target = TARGETS[0]!;
    const retryStore = makeStore([makeAddress(target)]);
    const retry = createBreachCheckService({ store: retryStore.store, source: SOURCE, lookup: async () => ({ status: "retryable_failure", retryAfterSeconds: 7200 }), raiseAlert: vi.fn() });
    expect(await retry.check(target)).toEqual({ status: "retryable_failure", retryAfterSeconds: 3600 });
    const retiredStore = makeStore([makeAddress(target)]);
    const raiseAlert = vi.fn();
    const retired = createBreachCheckService({ store: retiredStore.store, source: SOURCE, now: () => NOW, lookup: async () => ({ status: "breached", breaches: [{ name: "Old Breach", dataClasses: ["Passwords"], retired: true }] }), raiseAlert });
    expect(await retired.check(target)).toMatchObject({ status: "clean" });
    expect(retiredStore.upserts).toEqual([expect.objectContaining({ observations: [expect.objectContaining({ breachName: "Old Breach", retiredAt: NOW })] })]);
    expect(raiseAlert).not.toHaveBeenCalled();
  });

  it("checks matching targets and marks mismatched digest targets failed", async () => {
    const first = makeAddress(TARGETS[0]!, EMAIL);
    const second = makeAddress(TARGETS[1]!, "different@example.net");
    const lookup = vi.fn(async (): Promise<HIBPResult> => ({ status: "clean", breaches: [] }));
    const { store, updates } = makeStore([first, second]);
    const service = createBreachCheckService({ store, source: SOURCE, lookup, raiseAlert: vi.fn() });
    expect(await service.checkGroup(TARGETS)).toMatchObject([{ status: "clean" }, { status: "failed" }]);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(updates).toContainEqual(expect.objectContaining({ userId: TARGETS[1]!.userId, addressId: TARGETS[1]!.addressId, status: "failed" }));
  });

  it("performs exactly one lookup for a group of three targets even with a slow store", async () => {
    const third = { tenantId: "77777777-7777-4777-8777-777777777777", userId: "member-c", addressId: "88888888-8888-4888-8888-888888888888" };
    const group = [...TARGETS, third];
    const { store } = makeStore(group.map((target) => makeAddress(target)));
    const slow: BreachCheckStore = {
      ...store,
      getAddressForCheck: async (target) => { await new Promise((resolve) => setTimeout(resolve, 15)); return store.getAddressForCheck(target); },
      updateCheck: async (input) => { await new Promise((resolve) => setTimeout(resolve, 15)); return store.updateCheck(input); },
    };
    const lookup = vi.fn(async (): Promise<HIBPResult> => ({ status: "clean", breaches: [] }));
    const service = createBreachCheckService({ store: slow, source: SOURCE, now: () => NOW, lookup, raiseAlert: vi.fn() });
    const results = await service.checkGroup(group);
    expect(results.map((result) => result.status)).toEqual(["clean", "clean", "clean"]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("checks good targets when another encrypted row cannot be opened", async () => {
    const first = makeAddress(TARGETS[0]!, EMAIL);
    const second = makeAddress(TARGETS[1]!, EMAIL);
    second.encryptedAddress = new Uint8Array([1, 2, 3]);
    const lookup = vi.fn(async (): Promise<HIBPResult> => ({ status: "clean", breaches: [] }));
    const { store, updates } = makeStore([first, second]);
    const service = createBreachCheckService({ store, source: SOURCE, lookup, raiseAlert: vi.fn() });
    expect(await service.checkGroup(TARGETS)).toMatchObject([{ status: "clean" }, { status: "failed" }]);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(updates).toContainEqual(expect.objectContaining({ userId: TARGETS[1]!.userId, addressId: TARGETS[1]!.addressId, status: "failed" }));
  });

  it("drops invalid provider dates and domains before persistence", async () => {
    const target = TARGETS[0]!;
    const { store, upserts } = makeStore([makeAddress(target)]);
    const service = createBreachCheckService({
      store,
      source: SOURCE,
      now: () => NOW,
      lookup: async () => ({ status: "breached", breaches: [{ name: "Invalid metadata", domain: "https://evil.example/path", breachDate: "2024-02-31", addedDate: "not-a-date", dataClasses: ["Passwords"], retired: false }] }),
      raiseAlert: vi.fn(),
    });
    await service.check(target);
    const observations = (upserts[0] as { observations: Array<Record<string, unknown>> }).observations;
    expect(observations[0]).not.toHaveProperty("domain");
    expect(observations[0]).not.toHaveProperty("breachDate");
    expect(observations[0]).not.toHaveProperty("addedDate");
  });
});
