/**
 * `breach-monitoring` (Mondays 15:00 UTC): the discovery stage of the weekly breach check
 * (_specs/breach-monitoring.md). It groups the verified addresses by their global digest and sends one
 * `neo/breach-monitoring.check` event per group; the HIBP lookups stay in the event-triggered, rate-limited
 * Inngest worker whatever runner discovers. Plan = the events (one per address group; ids carry the run
 * date and the first tenant and address ids, no address-derived value); an address that cannot be decrypted
 * would be marked failed. Shadow makes no HIBP request and writes nothing; live marks and sends.
 */
import { getBreachRecipientStore } from "@/lib/server/breach-monitoring/check-services";
import { buildBreachCheckEvents, type BreachCheckEvent, type BreachRecipientStore } from "@/lib/server/breach-monitoring/orchestration";
import { inngest } from "@/inngest/client";
import { runJob, type Counts, type JobDeps, type JobReport, type RecordRun, type StepRunner } from "../core";
import type { RunMode, ScheduleRunnerName } from "../config";

const MAX_BATCH_SIZE = 500;

export type BreachRead = Pick<BreachRecipientStore, "listEligibleAddressIds" | "getAddressForCheck">;
export type BreachEffects = { updateCheck: BreachRecipientStore["updateCheck"]; sendEvents(events: BreachCheckEvent[]): Promise<unknown> };
export type BreachMonitoringDeps = JobDeps<BreachRead, BreachEffects>;

/** Production wiring. Returns undefined without a database (nothing to check). */
export function breachMonitoringDeps(mode: RunMode): BreachMonitoringDeps | undefined {
  const store = getBreachRecipientStore();
  if (!store) return undefined;
  const read: BreachRead = { listEligibleAddressIds: store.listEligibleAddressIds, getAddressForCheck: store.getAddressForCheck };
  if (mode === "shadow") return { mode, read };
  return { mode, read, effects: { updateCheck: store.updateCheck, sendEvents: (events) => inngest.send(events) } };
}

export async function runBreachMonitoring(options: {
  runner: ScheduleRunnerName;
  deps: BreachMonitoringDeps | undefined;
  steps: StepRunner;
  startedAt?: Date;
  env?: Record<string, string | undefined>;
  record?: RecordRun;
}): Promise<JobReport & { queued: number }> {
  const { deps } = options;
  const mode: RunMode = deps?.mode ?? "shadow";
  const meta = { job: "breach-monitoring" as const, runner: options.runner, mode, startedAt: options.startedAt ?? new Date() };
  let queued = 0;
  const report = await runJob({ meta, steps: options.steps, record: options.record }, async (rec): Promise<Counts> => {
    if (!deps) return { queued: 0 };
    const effects = deps.mode === "live" ? deps.effects : undefined;
    const events = await buildBreachCheckEvents({
      listEligibleAddressIds: deps.read.listEligibleAddressIds,
      getAddressForCheck: deps.read.getAddressForCheck,
      // The one write discovery makes: an address that cannot be decrypted is marked failed.
      updateCheck: async (input) => {
        rec.record({ tenantId: input.tenantId, kind: "breach.mark_failed", key: input.addressId });
        return effects ? effects.updateCheck(input) : false;
      },
      source: options.env ?? process.env,
    });
    // The event id already names the run date and the group's first tenant and address.
    for (const e of events) rec.record({ tenantId: null, kind: "breach.check", key: e.id });
    if (effects) {
      for (let offset = 0; offset < events.length; offset += MAX_BATCH_SIZE) await effects.sendEvents(events.slice(offset, offset + MAX_BATCH_SIZE));
    }
    queued = events.length;
    return { queued: events.length };
  });
  return { ...report, queued };
}
