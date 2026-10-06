import { describe, expect, it, vi } from "vitest";
import type { AddressRow } from "@neo/db";
import { deriveGlobalBreachQueryDigest, encryptMonitoredAddress } from "@/lib/server/breach-monitoring/crypto";
import { BREACH_CHECK_EVENT, BREACH_MAX_LOOKUP_ATTEMPTS, BREACH_MONITORING_WEEKLY_CRON, BREACH_TOKEN_CLEANUP_CRON, breachCheckExecutionConfig, buildBreachCheckEvents, buildBreachCheckRetryEvent, parseBreachCheckEvent, type BreachCheckEvent } from "@/lib/server/breach-monitoring/orchestration";

const MASTER = Buffer.alloc(32, 21).toString("base64");
const SOURCE = { NEO_MASTER_KEY: MASTER };
const EMAIL = "shared@example.com";
const TARGETS = [
  { tenantId: "11111111-1111-4111-8111-111111111111", userId: "member-a", addressId: "33333333-3333-4333-8333-333333333333" },
  { tenantId: "44444444-4444-4444-8444-444444444444", userId: "member-b", addressId: "55555555-5555-4555-8555-555555555555" },
];
function row(target: typeof TARGETS[number], email = EMAIL, verifiedAt: Date | undefined = new Date("2026-10-01T00:00:00Z")): AddressRow {
  return {
    id: target.addressId, tenantId: target.tenantId, userId: target.userId, digest: "0".repeat(64),
    encryptedAddress: encryptMonitoredAddress(email, target, SOURCE), verificationSource: "extra", verificationPending: !verifiedAt,
    verifiedAt, checkStatus: "never_checked", createdAt: new Date(), updatedAt: new Date(),
  };
}

describe("weekly breach-check event grouping", () => {
  it("accepts digest-free Inngest event IDs and rejects malformed ones", () => {
    const key = `2026-10-05:${TARGETS[0]!.tenantId}:${TARGETS[0]!.addressId}`;
    const invalid = { id: `${BREACH_CHECK_EVENT}:person@example.com`, name: BREACH_CHECK_EVENT, data: { attempt: 0, targets: TARGETS } };
    expect(parseBreachCheckEvent(invalid)).toBeUndefined();
    expect(parseBreachCheckEvent({ id: `${BREACH_CHECK_EVENT}:${"a".repeat(64)}`, name: BREACH_CHECK_EVENT, data: { attempt: 0, targets: TARGETS } })).toBeUndefined();
    const valid = { id: `${BREACH_CHECK_EVENT}:${key}`, name: BREACH_CHECK_EVENT, data: { attempt: 0, targets: TARGETS } };
    expect(parseBreachCheckEvent(valid)).toMatchObject({ id: valid.id, data: { targets: TARGETS, attempt: 0 } });
    const retry = { id: `${valid.id}:retry-1`, name: BREACH_CHECK_EVENT, data: { attempt: 1, targets: TARGETS } };
    expect(parseBreachCheckEvent(retry)).toMatchObject({ id: retry.id, data: { attempt: 1 } });
  });

  it("uses an id with no digest and the run date for retries too", async () => {
    const records = new Map(TARGETS.map((target) => [target.addressId, row(target)]));
    const now = () => new Date("2026-10-05T15:00:00Z");
    const events = await buildBreachCheckEvents({
      listEligibleAddressIds: async () => ({ items: TARGETS }),
      getAddressForCheck: async (target) => records.get(target.addressId),
      updateCheck: vi.fn(async () => true), source: SOURCE, now,
    });
    const digest = await deriveGlobalBreachQueryDigest(EMAIL, SOURCE);
    const retry = buildBreachCheckRetryEvent(events[0]!);
    expect(events[0]!.id).toMatch(/^neo\/breach-monitoring\.check:2026-10-05:/);
    for (const id of [events[0]!.id, retry.id]) expect(id).not.toContain(digest);
    expect(retry.id).toBe(`${events[0]!.id}:retry-1`);
  });

  it("keeps different normalized addresses in separate digest-keyed events", async () => {
    const records = new Map([
      [TARGETS[0]!.addressId, row(TARGETS[0]!, EMAIL)],
      [TARGETS[1]!.addressId, row(TARGETS[1]!, "another@example.net")],
    ]);
    const events = await buildBreachCheckEvents({
      listEligibleAddressIds: async () => ({ items: TARGETS }),
      getAddressForCheck: async (target) => records.get(target.addressId),
      updateCheck: vi.fn(async () => true),
      source: SOURCE,
    });
    expect(events).toHaveLength(2);
    expect(events[0]!.data.targets).toHaveLength(1);
    expect(events[1]!.data.targets).toHaveLength(1);
    expect(events[0]!.id).not.toBe(events[1]!.id);
    expect(JSON.stringify(events.map((event) => event.data))).not.toContain(EMAIL);
  });

  it("uses one account-wide RPM throttle and serializes equal digest events", () => {
    const config = breachCheckExecutionConfig(42);
    expect(config).toEqual({ retries: 1, throttle: { limit: 42, period: "1m" }, concurrency: { limit: 1, key: "event.id" } });
    expect(BREACH_MAX_LOOKUP_ATTEMPTS).toBe(3);
    expect(config.throttle).not.toHaveProperty("key");
    expect(BREACH_MONITORING_WEEKLY_CRON).toBe("0 15 * * 1");
    expect(BREACH_TOKEN_CLEANUP_CRON).toBe("0 4 * * *");
  });

  it("groups the same normalized address across households and keeps only IDs in event data", async () => {
    const records = new Map(TARGETS.map((target) => [target.addressId, row(target, " Shared@Example.com ")]));
    const listEligibleAddressIds = vi.fn(async (input?: { cursor?: string }) => input?.cursor
      ? { items: [TARGETS[1]!] }
      : { items: [TARGETS[0]!], nextCursor: "page-2" });
    const getAddressForCheck = vi.fn(async (target: typeof TARGETS[number]) => records.get(target.addressId));
    const events = await buildBreachCheckEvents({ listEligibleAddressIds, getAddressForCheck, updateCheck: vi.fn(async () => true), source: SOURCE, pageSize: 1 });
    expect(listEligibleAddressIds).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(1);
    const digest = await deriveGlobalBreachQueryDigest(EMAIL, SOURCE);
    const first = [`${TARGETS[0]!.tenantId}:${TARGETS[0]!.addressId}`, `${TARGETS[1]!.tenantId}:${TARGETS[1]!.addressId}`].sort()[0];
    expect(events[0]!.id).toBe(`${BREACH_CHECK_EVENT}:${new Date().toISOString().slice(0, 10)}:${first}`);
    expect(events[0]!.id).not.toContain(digest);
    expect(JSON.stringify(events)).not.toContain(digest);
    expect(events[0]!.name).toBe(BREACH_CHECK_EVENT);
    expect(events[0]!.data).toEqual({ attempt: 0, targets: TARGETS });
    expect(JSON.stringify(events[0]!.data)).not.toContain(EMAIL);
    expect(JSON.stringify(events[0]!.data)).not.toContain(digest);
    expect(Object.keys(events[0]!.data).sort()).toEqual(["attempt", "targets"]);
  });

  it("builds delayed retry events with the same digest-free key and target IDs, not event data", () => {
    const first: BreachCheckEvent = { id: `${BREACH_CHECK_EVENT}:2026-10-05:${TARGETS[0]!.tenantId}:${TARGETS[0]!.addressId}`, name: BREACH_CHECK_EVENT, data: { attempt: 0, targets: TARGETS } };
    expect(buildBreachCheckRetryEvent(first)).toEqual({
      id: `${first.id}:retry-1`, name: BREACH_CHECK_EVENT, data: { attempt: 1, targets: TARGETS },
    });
  });

  it("marks an undecryptable address failed and still queues valid addresses", async () => {
    const corrupt = row(TARGETS[0]!);
    corrupt.encryptedAddress = new Uint8Array([1, 2, 3]);
    const records = new Map([
      [TARGETS[0]!.addressId, corrupt],
      [TARGETS[1]!.addressId, row(TARGETS[1]!)],
    ]);
    const updateCheck = vi.fn(async () => true);
    const events = await buildBreachCheckEvents({
      listEligibleAddressIds: async () => ({ items: TARGETS }),
      getAddressForCheck: async (target) => records.get(target.addressId),
      updateCheck,
      source: SOURCE,
    });
    expect(updateCheck).toHaveBeenCalledWith(expect.objectContaining({
      ...TARGETS[0]!, status: "failed", checkedAt: expect.any(Date),
    }));
    expect(events).toHaveLength(1);
    expect(events[0]!.data.targets).toEqual([TARGETS[1]!]);
  });

  it("marks weekly discovery addresses failed when the master key is unavailable", async () => {
    const updateCheck = vi.fn(async () => true);
    const events = await buildBreachCheckEvents({
      listEligibleAddressIds: async () => ({ items: [TARGETS[0]!] }),
      getAddressForCheck: async () => row(TARGETS[0]!),
      updateCheck,
      source: { VERCEL_ENV: "production" },
    });
    expect(events).toEqual([]);
    expect(updateCheck).toHaveBeenCalledWith(expect.objectContaining({
      ...TARGETS[0]!, status: "failed", checkedAt: expect.any(Date),
    }));
  });

  it("does not queue missing or unverified addresses", async () => {
    const pending = { ...TARGETS[0]!, addressId: "66666666-6666-4666-8666-666666666666" };
    const getAddressForCheck = vi.fn(async (target: typeof TARGETS[number] | typeof pending) => {
      if (target.addressId === pending.addressId) return { ...row(pending), verifiedAt: undefined, verificationPending: true };
      if (target.addressId === TARGETS[0]!.addressId) return row(TARGETS[0]!);
      return undefined;
    });
    const events = await buildBreachCheckEvents({
      listEligibleAddressIds: async () => ({ items: [TARGETS[0]!, pending, TARGETS[1]!] }),
      getAddressForCheck,
      updateCheck: vi.fn(async () => true),
      source: SOURCE,
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.data.targets).toEqual([TARGETS[0]!]);
  });
});
