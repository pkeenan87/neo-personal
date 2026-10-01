/**
 * Device signals and expected remote-access tools (_specs/signals.md): Postgres via @neo/db
 * when DATABASE_URL is set, else memory-signals.ts. One function per @neo/db signals.ts
 * function, same arguments minus `db`. Rule evaluation, ingest orchestration and escalation
 * live in sibling modules; this is storage only.
 */
import {
  countDeviceSignalsSince as dbCountDeviceSignalsSince,
  getDeviceSignal as dbGetDeviceSignal,
  insertDeviceSignal as dbInsertDeviceSignal,
  listDeviceSignalsByClientIds as dbListDeviceSignalsByClientIds,
  listExpectedTools as dbListExpectedTools,
  listRecentUserSignals as dbListRecentUserSignals,
  purgeExpiredReputationCache as dbPurgeExpiredReputationCache,
  purgeOldDeviceSignals as dbPurgeOldDeviceSignals,
  setExpectedTools as dbSetExpectedTools,
  updateDeviceSignal as dbUpdateDeviceSignal,
  type DeviceSignalRow,
  type ExpectedToolRow,
  type SignalOutcome,
} from "@neo/db";
import { getDb } from "../db";
import {
  memoryCountDeviceSignalsSince,
  memoryGetDeviceSignal,
  memoryInsertDeviceSignal,
  memoryListDeviceSignalsByClientIds,
  memoryListExpectedTools,
  memoryListRecentUserSignals,
  memoryPurgeOldDeviceSignals,
  memorySetExpectedTools,
  memoryUpdateDeviceSignal,
  type MemoryInsertDeviceSignalInput,
  type MemorySetExpectedToolsInput,
  type MemoryUpdateDeviceSignalPatch,
} from "../memory-signals";

export type { DeviceSignalRow, ExpectedToolRow };

export async function insertDeviceSignal(input: MemoryInsertDeviceSignalInput): Promise<{ row: DeviceSignalRow; duplicate: boolean }> {
  const db = getDb();
  return db ? dbInsertDeviceSignal(db, input) : memoryInsertDeviceSignal(input);
}

export async function getDeviceSignal(tenantId: string, id: string): Promise<DeviceSignalRow | undefined> {
  const db = getDb();
  return db ? dbGetDeviceSignal(db, tenantId, id) : memoryGetDeviceSignal(tenantId, id);
}

export async function updateDeviceSignal(tenantId: string, id: string, patch: MemoryUpdateDeviceSignalPatch): Promise<DeviceSignalRow | undefined> {
  const db = getDb();
  return db ? dbUpdateDeviceSignal(db, tenantId, id, patch) : memoryUpdateDeviceSignal(tenantId, id, patch);
}

/** This device's rows among `clientEventIds` (`GET /api/signals/status`). Unknown ids omitted. */
export async function listDeviceSignalsByClientIds(tenantId: string, deviceId: string, clientEventIds: readonly string[]): Promise<DeviceSignalRow[]> {
  const db = getDb();
  return db ? dbListDeviceSignalsByClientIds(db, tenantId, deviceId, clientEventIds) : memoryListDeviceSignalsByClientIds(tenantId, deviceId, clientEventIds);
}

/** A member's signals since `opts.since`, oldest first (for correlation). */
export async function listRecentUserSignals(
  tenantId: string,
  userId: string,
  opts: { since: Date; outcomes?: readonly SignalOutcome[] },
): Promise<DeviceSignalRow[]> {
  const db = getDb();
  return db ? dbListRecentUserSignals(db, tenantId, userId, opts) : memoryListRecentUserSignals(tenantId, userId, opts);
}

export async function countDeviceSignalsSince(tenantId: string, deviceId: string, since: Date, opts: { escalatedOnly?: boolean } = {}): Promise<number> {
  const db = getDb();
  return db ? dbCountDeviceSignalsSince(db, tenantId, deviceId, since, opts) : memoryCountDeviceSignalsSince(tenantId, deviceId, since, opts);
}

export async function purgeOldDeviceSignals(): Promise<number> {
  const db = getDb();
  return db ? dbPurgeOldDeviceSignals(db) : memoryPurgeOldDeviceSignals();
}

/** Retention: expired reputation_cache rows. No in-memory twin needed: InMemoryReputationCache treats an expired entry as a miss on read. */
export async function purgeExpiredReputationCache(): Promise<number> {
  const db = getDb();
  return db ? dbPurgeExpiredReputationCache(db) : 0;
}

export async function listExpectedTools(tenantId: string, opts: { deviceId?: string } = {}): Promise<ExpectedToolRow[]> {
  const db = getDb();
  return db ? dbListExpectedTools(db, tenantId, opts) : memoryListExpectedTools(tenantId, opts);
}

export async function setExpectedTools(input: MemorySetExpectedToolsInput): Promise<ExpectedToolRow[] | undefined> {
  const db = getDb();
  return db ? dbSetExpectedTools(db, input) : memorySetExpectedTools(input);
}
