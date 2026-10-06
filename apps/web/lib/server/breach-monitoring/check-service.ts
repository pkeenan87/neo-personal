import type { AddressRow, BreachObservationInput, BreachObservationRow } from "@neo/db";
import type { EnvSource } from "@/lib/env";
import { decryptMonitoredAddress, deriveGlobalBreachQueryDigest } from "./crypto";
import { HIBP_MAX_RETRY_AFTER_SECONDS, lookupBreachedAccount, type HIBPResult } from "./hibp";
import { sanitizeBreachDataClass, sanitizeBreachName } from "./sanitize";

export type BreachCheckTarget = { tenantId: string; userId: string; addressId: string };
export interface BreachCheckStore {
  getAddressForCheck(target: BreachCheckTarget): Promise<AddressRow | undefined>;
  updateCheck(input: BreachCheckTarget & { status: "clean" | "breached" | "failed"; checkedAt: Date }): Promise<boolean>;
  upsertObservations(input: BreachCheckTarget & { observations: BreachObservationInput[]; now: Date }): Promise<{ newObservations: BreachObservationRow[] }>;
}
export type BreachCheckResult =
  | { status: "skipped" | "clean" | "breached" | "failed" }
  | { status: "retryable_failure"; retryAfterSeconds?: number; };

type BreachAlert = (input: { tenantId: string; userId: string; addressId: string; breachName: string; dataClasses: string[] }) => Promise<unknown>;
const inFlightLookups = new Map<string, Promise<HIBPResult>>();

async function lookupOnce(digest: string, email: string, lookup: (email: string) => Promise<HIBPResult>): Promise<HIBPResult> {
  const existing = inFlightLookups.get(digest);
  if (existing) return existing;
  const pending = Promise.resolve().then(() => lookup(email)).catch((): HIBPResult => ({ status: "retryable_failure" }));
  inFlightLookups.set(digest, pending);
  try {
    return await pending;
  } finally {
    if (inFlightLookups.get(digest) === pending) inFlightLookups.delete(digest);
  }
}

function safeDate(value: string | undefined, dateOnly = false): Date | undefined {
  if (!value) return undefined;
  if (dateOnly && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(dateOnly ? `${value}T00:00:00.000Z` : value);
  if (!Number.isFinite(date.getTime())) return undefined;
  if (dateOnly && date.toISOString().slice(0, 10) !== value) return undefined;
  return date;
}

function mapObservations(result: Extract<HIBPResult, { status: "breached" }>, checkedAt: Date): BreachObservationInput[] {
  return result.breaches.map((breach) => {
    const breachName = sanitizeBreachName(breach.name);
    const domain = breach.domain?.trim().toLowerCase();
    const dataClasses = [...new Set(breach.dataClasses.map(sanitizeBreachDataClass).filter(Boolean))].slice(0, 100);
    const breachDate = safeDate(breach.breachDate, true);
    const addedDate = safeDate(breach.addedDate);
    return {
      breachName,
      ...(domain && domain.length <= 253 && /^[a-z0-9.-]+$/.test(domain) ? { domain } : {}),
      ...(breachDate ? { breachDate } : {}),
      ...(addedDate ? { addedDate } : {}),
      dataClasses,
      ...(breach.retired ? { retiredAt: checkedAt } : {}),
    };
  });
}

export function createBreachCheckService(deps: {
  store: BreachCheckStore;
  source?: EnvSource;
  now?: () => Date;
  lookup?: (email: string) => Promise<HIBPResult>;
  raiseAlert: BreachAlert;
}) {
  const source = deps.source ?? process.env;
  const now = deps.now ?? (() => new Date());
  const lookup = deps.lookup ?? ((email: string) => lookupBreachedAccount(email, { source }));

  /** Applies one lookup result to one target. Never performs a lookup itself. */
  async function applyResult(target: BreachCheckTarget, result: HIBPResult): Promise<BreachCheckResult> {
    const checkedAt = now();
    if (result.status === "retryable_failure") {
      await deps.store.updateCheck({ ...target, status: "failed", checkedAt });
      const retryAfterSeconds = result.retryAfterSeconds;
      return {
        status: "retryable_failure",
        ...(retryAfterSeconds && retryAfterSeconds > 0
          ? { retryAfterSeconds: Math.min(retryAfterSeconds, HIBP_MAX_RETRY_AFTER_SECONDS) }
          : {}),
      };
    }
    if (result.status === "configuration_failure" || result.status === "invalid_request") {
      await deps.store.updateCheck({ ...target, status: "failed", checkedAt });
      return { status: "failed" };
    }

    const observations = result.status === "breached" ? mapObservations(result, checkedAt) : [];
    const upserted = observations.length
      ? await deps.store.upsertObservations({ ...target, observations, now: checkedAt })
      : { newObservations: [] as BreachObservationRow[] };
    const hasActiveBreach = result.status === "breached" && result.breaches.some((breach) => !breach.retired);
    const status = hasActiveBreach ? "breached" : "clean";
    const updated = await deps.store.updateCheck({ ...target, status, checkedAt });
    if (!updated) return { status: "skipped" };
    const stillEligible = await deps.store.getAddressForCheck(target);
    if (!stillEligible?.verifiedAt || stillEligible.verificationPending) return { status: "skipped" };
    for (const observation of upserted.newObservations) {
      await deps.raiseAlert({
        tenantId: target.tenantId,
        userId: target.userId,
        addressId: target.addressId,
        breachName: observation.breachName,
        dataClasses: observation.dataClasses,
      });
    }
    return { status };
  }

  /**
   * Checks targets that share one normalized address with exactly one lookup. The first eligible
   * target's address is the group's reference; a target that decrypts to a different address fails.
   * The global digest stays in this process and is never carried by events.
   */
  async function checkGroup(targets: BreachCheckTarget[]): Promise<BreachCheckResult[]> {
    const outcomes = new Map<string, BreachCheckResult>();
    const eligible: BreachCheckTarget[] = [];
    const targetKey = (target: BreachCheckTarget) => JSON.stringify([target.tenantId, target.userId, target.addressId]);
    let reference: { digest: string; email: string } | undefined;
    for (const target of targets) {
      const address = await deps.store.getAddressForCheck(target);
      if (!address?.verifiedAt || address.verificationPending) continue;
      try {
        const email = decryptMonitoredAddress(address.encryptedAddress, {
          tenantId: address.tenantId,
          userId: address.userId,
          addressId: address.id,
        }, source);
        const digest = await deriveGlobalBreachQueryDigest(email, source);
        reference ??= { digest, email };
        if (digest !== reference.digest) {
          await deps.store.updateCheck({ ...target, status: "failed", checkedAt: now() });
          outcomes.set(targetKey(target), { status: "failed" });
          continue;
        }
        eligible.push(target);
      } catch {
        await deps.store.updateCheck({ ...target, status: "failed", checkedAt: now() });
        outcomes.set(targetKey(target), { status: "failed" });
      }
    }
    if (reference && eligible.length) {
      const result = await lookupOnce(reference.digest, reference.email, lookup);
      const applied = await Promise.all(eligible.map(async (target) => [targetKey(target), await applyResult(target, result)] as const));
      for (const [key, outcome] of applied) outcomes.set(key, outcome);
    }
    return targets.map((target) => outcomes.get(targetKey(target))).filter((result): result is BreachCheckResult => Boolean(result));
  }

  /** Single-target convenience over `checkGroup`. */
  async function check(target: BreachCheckTarget): Promise<BreachCheckResult> {
    return (await checkGroup([target]))[0] ?? { status: "skipped" };
  }

  return { check, checkGroup };
}
