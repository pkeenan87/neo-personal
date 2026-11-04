// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { AddressRow, ScheduleRunInput } from "@neo/db";
import { encryptMonitoredAddress } from "@/lib/server/breach-monitoring/crypto";
import { inlineSteps, plannedActionsDigest } from "@/lib/server/schedules/core";
import { runBreachMonitoring } from "@/lib/server/schedules/jobs/breach-monitoring";
import { runDevicesOffline } from "@/lib/server/schedules/jobs/devices-offline";
import { runOutboxSweep } from "@/lib/server/schedules/jobs/outbox-sweep";
import { runRetention } from "@/lib/server/schedules/jobs/retention";
import { runWeeklyDigest } from "@/lib/server/schedules/jobs/weekly-digest";

// The write side of a shadow run does not exist by type. This is the runtime proof: even if a wiring bug
// handed a shadow run its effects, any touch (property read or call) fails the test.
function tripwire(): never {
  return new Proxy(function () {}, {
    get: () => { throw new Error("shadow run touched an effect"); },
    apply: () => { throw new Error("shadow run called an effect"); },
  }) as never;
}

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "44444444-4444-4444-8444-444444444444";

function recorder() {
  const rows: ScheduleRunInput[] = [];
  return { rows, record: vi.fn(async (row: ScheduleRunInput) => void rows.push(row)) };
}

describe("devices-offline", () => {
  const stale = [{ id: "d1", tenantId: T1 }, { id: "d2", tenantId: T2 }];
  const read = { listStale: vi.fn(async () => stale) };
  const now = new Date("2026-11-03T10:00:00Z");

  it("plans the same actions in shadow and live; shadow performs nothing", async () => {
    const shadowRec = recorder();
    const shadow = await runDevicesOffline({ runner: "eve", deps: { mode: "shadow", read, effects: tripwire() } as never, steps: inlineSteps, now, record: shadowRec.record });

    const effects = {
      markOffline: vi.fn(async (_t: string, id: string) => ({ id }) as never),
      alertOffline: vi.fn(async () => true),
      protectionDisabled: vi.fn(async () => undefined),
    };
    const liveRec = recorder();
    const live = await runDevicesOffline({ runner: "inngest", deps: { mode: "live", read, effects }, steps: inlineSteps, now, record: liveRec.record });

    expect(shadow.mode).toBe("shadow");
    expect(live.mode).toBe("live");
    expect(shadow.digest).toBe(live.digest);
    expect(shadow.digest).toBe(plannedActionsDigest([
      { tenantId: T1, kind: "device.offline", key: "d1" },
      { tenantId: T2, kind: "device.offline", key: "d2" },
    ]));
    expect(effects.markOffline).toHaveBeenCalledTimes(2);
    expect(effects.alertOffline).toHaveBeenCalledTimes(2);
    expect(shadowRec.rows).toHaveLength(1);
    expect(shadowRec.rows[0]).toMatchObject({ job: "devices-offline", runner: "eve", mode: "shadow", outcome: "ok" });
    expect(liveRec.rows[0]).toMatchObject({ runner: "inngest", mode: "live", outcome: "ok" });
  });

  it("records an error run and rethrows", async () => {
    const { rows, record } = recorder();
    const boom = { listStale: async () => { throw new Error("db down"); } };
    await expect(runDevicesOffline({ runner: "eve", deps: { mode: "shadow", read: boom }, steps: inlineSteps, record })).rejects.toThrow("db down");
    expect(rows[0]).toMatchObject({ outcome: "error", error: "db down" });
  });
});

describe("outbox-sweep", () => {
  it("plans the households with rows due; shadow never drains", async () => {
    const read = { pendingTenants: async () => [T1, T2] };
    const shadow = await runOutboxSweep({ runner: "eve", deps: { mode: "shadow", read, effects: tripwire() } as never, steps: inlineSteps, record: recorder().record });
    const drain = vi.fn(async () => ({ claimed: 2, sent: 2, retry: 0, gaveUp: 0 }));
    const live = await runOutboxSweep({ runner: "inngest", deps: { mode: "live", read, effects: { drain } }, steps: inlineSteps, record: recorder().record });
    expect(shadow.digest).toBe(live.digest);
    expect(shadow.actions).toBe(2);
    expect(drain).toHaveBeenCalledTimes(1);
    expect(live.counts).toMatchObject({ sent: 2, claimed: 2 });
  });
});

describe("retention", () => {
  const read = { listExpiredArtifacts: vi.fn(async () => [{ id: "a1", tenantId: T1 }, { id: "a2", tenantId: T2 }]) };

  it("plans the expired artifacts and each purge; live purges the planned artifacts only", async () => {
    const shadow = await runRetention({ runner: "eve", deps: { mode: "shadow", read, effects: tripwire() } as never, steps: inlineSteps, record: recorder().record });

    const effects = {
      purgeOldInbound: vi.fn(async () => 1),
      purgeOldAlerts: vi.fn(async () => 2),
      purgeOldDevices: vi.fn(async () => 3),
      purgeOldDeviceSignals: vi.fn(async () => 4),
      purgeExpiredReputationCache: vi.fn(async () => 5),
      purgeWeeklyDigestPayloads: vi.fn(async () => 6),
      expireChildRequests: vi.fn(async () => 7),
      pruneScheduleRuns: vi.fn(async () => 8),
      purgeExpiredMemory: vi.fn(async () => 9),
      purgeArtifact: vi.fn(async () => undefined),
    };
    const live = await runRetention({ runner: "inngest", deps: { mode: "live", read, effects }, steps: inlineSteps, record: recorder().record });

    expect(shadow.digest).toBe(live.digest);
    expect(shadow.actions).toBe(2 + 9);
    expect(effects.purgeArtifact).toHaveBeenCalledWith("a1", T1);
    expect(effects.purgeArtifact).toHaveBeenCalledWith("a2", T2);
    expect(effects.purgeOldInbound).toHaveBeenCalledWith(90);
    for (const fn of [effects.purgeOldAlerts, effects.purgeOldDevices, effects.purgeOldDeviceSignals, effects.purgeExpiredReputationCache, effects.purgeWeeklyDigestPayloads, effects.expireChildRequests, effects.pruneScheduleRuns, effects.purgeExpiredMemory]) {
      expect(fn).toHaveBeenCalledTimes(1);
    }
    expect(live.counts).toMatchObject({ artifactsPurged: 2, childRequestsExpired: 7, scheduleRunsPruned: 8, householdMemoryPurged: 9 });
  });

  it("Inngest records in a final step, once", async () => {
    const names: string[] = [];
    const steps = { run: async <T,>(name: string, fn: () => Promise<T>) => { names.push(name); return fn(); } };
    const { rows, record } = recorder();
    await runRetention({ runner: "inngest", deps: { mode: "shadow", read }, steps, record, recordInStep: true });
    expect(names.filter((n) => n === "record-run")).toHaveLength(1);
    expect(rows).toHaveLength(1);
  });
});

describe("weekly-digest", () => {
  const pairs = [{ tenantId: T1, userId: "u1" }, { tenantId: T1, userId: "u2" }, { tenantId: T2, userId: "u3" }];
  const read = { listDigestRecipientPairs: vi.fn(async () => ({ items: pairs })) };
  const now = () => new Date("2026-11-02T14:00:00Z");

  it("plans one send per recipient and week; shadow sends no event", async () => {
    const shadow = await runWeeklyDigest({ runner: "eve", deps: { mode: "shadow", read, effects: tripwire() } as never, steps: inlineSteps, now, record: recorder().record });
    const sendEvent = vi.fn(async () => undefined);
    const live = await runWeeklyDigest({ runner: "inngest", deps: { mode: "live", read, effects: { sendEvent } }, steps: inlineSteps, now, record: recorder().record });

    expect(shadow.digest).toBe(live.digest);
    expect(shadow.recipients).toBe(3);
    expect(sendEvent).toHaveBeenCalledTimes(1);
    const events = (sendEvent.mock.calls[0] as unknown as [string, Array<{ id: string; name: string }>])[1];
    expect(events.map((e) => e.id)).toEqual(pairs.map((p) => `digest:${p.userId}:${live.period.isoWeek}`));
    expect(events.every((e) => e.name === "neo/digest.generate")).toBe(true);
  });
});

describe("breach-monitoring", () => {
  const MASTER = Buffer.alloc(32, 21).toString("base64");
  const env = { NEO_MASTER_KEY: MASTER };
  const targets = [
    { tenantId: T1, userId: "member-a", addressId: "33333333-3333-4333-8333-333333333333" },
    { tenantId: T2, userId: "member-b", addressId: "55555555-5555-4555-8555-555555555555" },
    { tenantId: T2, userId: "member-c", addressId: "66666666-6666-4666-8666-666666666666" },
  ];
  const verifiedAt = new Date("2026-10-01T00:00:00Z");
  function row(t: (typeof targets)[number], email: string, garbage = false): AddressRow {
    return {
      id: t.addressId, tenantId: t.tenantId, userId: t.userId, digest: "0".repeat(64),
      encryptedAddress: garbage ? new Uint8Array([1, 2, 3]) : encryptMonitoredAddress(email, t, env),
      verificationSource: "extra", verificationPending: false, verifiedAt, checkStatus: "never_checked", createdAt: new Date(), updatedAt: new Date(),
    };
  }
  const rows = new Map([
    [targets[0]!.addressId, row(targets[0]!, "one@example.com")],
    [targets[1]!.addressId, row(targets[1]!, "one@example.com")], // same address: one group
    [targets[2]!.addressId, row(targets[2]!, "x", true)],         // cannot be decrypted: would be marked failed
  ]);
  const read = { listEligibleAddressIds: async () => ({ items: targets }), getAddressForCheck: async (t: { addressId: string }) => rows.get(t.addressId) };

  it("plans the address groups and the failed marks; shadow makes no write and no HIBP call", async () => {
    const shadowRec = recorder();
    const shadow = await runBreachMonitoring({ runner: "eve", deps: { mode: "shadow", read, effects: tripwire() } as never, steps: inlineSteps, env, record: shadowRec.record });
    const effects = { updateCheck: vi.fn(async () => true), sendEvents: vi.fn(async () => undefined) };
    const live = await runBreachMonitoring({ runner: "inngest", deps: { mode: "live", read, effects }, steps: inlineSteps, env, record: recorder().record });

    expect(shadow.digest).toBe(live.digest);
    expect(shadow.queued).toBe(1);
    expect(shadow.counts).toMatchObject({ "planned.breach.check": 1, "planned.breach.mark_failed": 1 });
    expect(effects.updateCheck).toHaveBeenCalledWith(expect.objectContaining({ addressId: targets[2]!.addressId, status: "failed" }));
    expect(effects.sendEvents).toHaveBeenCalledTimes(1);
    // No address, address digest or event payload reaches the stored summary.
    expect(JSON.stringify(shadowRec.rows[0])).not.toContain("example.com");
  });

  it("does nothing without a database", async () => {
    const report = await runBreachMonitoring({ runner: "eve", deps: undefined, steps: inlineSteps, record: recorder().record });
    expect(report.queued).toBe(0);
  });
});
