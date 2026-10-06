import type { AddressRow } from "@neo/db";
import type { EnvSource } from "@/lib/env";
import { decryptMonitoredAddress, deriveGlobalBreachQueryDigest } from "./crypto";
import type { BreachCheckTarget } from "./check-service";

export const BREACH_CHECK_EVENT = "neo/breach-monitoring.check";
export const BREACH_MONITORING_WEEKLY_CRON = "0 15 * * 1";
export const BREACH_TOKEN_CLEANUP_CRON = "0 4 * * *";
export const BREACH_MAX_LOOKUP_ATTEMPTS = 3;
const DEFAULT_PAGE_SIZE = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function configuredRpm(rpm: number): number {
  return Number.isInteger(rpm) && rpm >= 1 && rpm <= 1000 ? rpm : 10;
}

export function breachCheckExecutionConfig(rpm: number) {
  return {
    // Provider retries are fresh Inngest runs so every HIBP request consumes the global quota.
    // One platform retry covers a transient crash; step results are memoized so it never repeats a finished lookup.
    retries: 1 as const,
    throttle: { limit: configuredRpm(rpm), period: "1m" as const },
    concurrency: { limit: 1 as const, key: "event.id" as const },
  };
}

export type BreachCheckEvent = {
  id: string;
  name: typeof BREACH_CHECK_EVENT;
  data: { attempt: number; targets: BreachCheckTarget[] };
};

export interface BreachRecipientStore {
  listEligibleAddressIds(input?: { cursor?: string; limit?: number }): Promise<{ items: BreachCheckTarget[]; nextCursor?: string }>;
  getAddressForCheck(target: BreachCheckTarget): Promise<AddressRow | undefined>;
  updateCheck(input: BreachCheckTarget & { status: "failed"; checkedAt: Date }): Promise<boolean>;
}

export async function buildBreachCheckEvents(input: {
  listEligibleAddressIds: BreachRecipientStore["listEligibleAddressIds"];
  getAddressForCheck: BreachRecipientStore["getAddressForCheck"];
  updateCheck: BreachRecipientStore["updateCheck"];
  source?: EnvSource;
  pageSize?: number;
  now?: () => Date;
}): Promise<BreachCheckEvent[]> {
  const source = input.source ?? process.env;
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) throw new Error("Breach discovery page size must be 1..1000");
  const groups = new Map<string, Map<string, BreachCheckTarget>>();
  let cursor: string | undefined;
  do {
    const previousCursor = cursor;
    const page = await input.listEligibleAddressIds({ ...(cursor ? { cursor } : {}), limit: pageSize });
    for (const target of page.items) {
      const address = await input.getAddressForCheck(target);
      if (!address?.verifiedAt || address.verificationPending) continue;
      try {
        const email = decryptMonitoredAddress(address.encryptedAddress, {
          tenantId: address.tenantId,
          userId: address.userId,
          addressId: address.id,
        }, source);
        const digest = await deriveGlobalBreachQueryDigest(email, source);
        const group = groups.get(digest) ?? new Map<string, BreachCheckTarget>();
        group.set(JSON.stringify([target.tenantId, target.userId, target.addressId]), target);
        groups.set(digest, group);
      } catch {
        await input.updateCheck({ ...target, status: "failed", checkedAt: new Date() });
        continue;
      }
    }
    cursor = page.nextCursor;
    if (cursor && cursor === previousCursor) throw new Error("Breach discovery cursor did not advance");
  } while (cursor);

  // The global digest only groups targets in memory; event IDs carry the run date and the group's
  // lexicographically first tenant/address pair instead, so no address-derived value reaches Inngest.
  const runDate = (input.now ?? (() => new Date()))().toISOString().slice(0, 10);
  const events = [...groups.values()].map((group): BreachCheckEvent => {
    const targets = [...group.values()];
    const first = targets.map((target) => `${target.tenantId}:${target.addressId}`).sort()[0]!;
    return { id: `${BREACH_CHECK_EVENT}:${runDate}:${first}`, name: BREACH_CHECK_EVENT, data: { attempt: 0, targets } };
  });
  return events.sort((a, b) => a.id.localeCompare(b.id));
}

const EVENT_KEY_RE = /^\d{4}-\d{2}-\d{2}:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function buildBreachCheckRetryEvent(event: BreachCheckEvent): BreachCheckEvent {
  const prefix = `${BREACH_CHECK_EVENT}:`;
  const key = event.id.startsWith(prefix) ? (event.id.slice(prefix.length).split(":retry-")[0] ?? "") : "";
  if (!EVENT_KEY_RE.test(key) || event.data.attempt >= BREACH_MAX_LOOKUP_ATTEMPTS - 1) {
    throw new Error("Invalid breach-check retry event");
  }
  const attempt = event.data.attempt + 1;
  return {
    id: `${prefix}${key}:retry-${attempt}`,
    name: BREACH_CHECK_EVENT,
    data: { attempt, targets: event.data.targets },
  };
}

export function parseBreachCheckEvent(input: { id: unknown; name: unknown; data: unknown }): BreachCheckEvent | undefined {
  if (input.name !== BREACH_CHECK_EVENT || typeof input.id !== "string" || input.id.length > 160) return undefined;
  const prefix = `${BREACH_CHECK_EVENT}:`;
  if (!input.id.startsWith(prefix)) return undefined;
  const keyPart = input.id.slice(prefix.length);
  const keyMatch = /^(.+?)(?::retry-([1-2]))?$/.exec(keyPart);
  if (!keyMatch || !EVENT_KEY_RE.test(keyMatch[1]!) || !input.data || typeof input.data !== "object") return undefined;
  const raw = input.data as { targets?: unknown; attempt?: unknown };
  const idAttempt = keyMatch[2] ? Number(keyMatch[2]) : 0;
  if (!Number.isInteger(raw.attempt) || raw.attempt !== idAttempt) return undefined;
  if (!Array.isArray(raw.targets) || raw.targets.length === 0 || raw.targets.length > 1000) return undefined;
  const targets: BreachCheckTarget[] = [];
  for (const value of raw.targets) {
    if (!value || typeof value !== "object") return undefined;
    const target = value as Record<string, unknown>;
    if (typeof target.tenantId !== "string" || !UUID.test(target.tenantId)) return undefined;
    if (typeof target.userId !== "string" || target.userId.length < 1 || target.userId.length > 128) return undefined;
    if (typeof target.addressId !== "string" || !UUID.test(target.addressId)) return undefined;
    targets.push({ tenantId: target.tenantId, userId: target.userId, addressId: target.addressId });
  }
  return { id: input.id, name: BREACH_CHECK_EVENT, data: { attempt: idAttempt, targets } };
}
