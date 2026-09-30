/**
 * In-memory device signals and expected remote-access tools when DATABASE_URL is unset
 * (MOCK_MODE, tests). Mirrors @neo/db signals.ts: same semantics (idempotency by
 * (deviceId, clientEventId), correlation query, per-device counters, expected-tools
 * replace-the-set). The shared reputation cache has its own in-memory twin
 * (`@neo/tools` `createInMemoryCache`, see `lib/server/agent-run.ts` `sharedUrlCache`) and does
 * not live here.
 */
import type { DeviceSignalRow, ExpectedToolRow, SignalOutcome, SignalSeverity } from "@neo/db";
import { memoryGetDevice } from "./memory-devices";

type MemSignal = DeviceSignalRow;

const g = globalThis as typeof globalThis & {
  __neoMemorySignals?: { signals: Map<string, MemSignal>; expectedTools: Map<string, ExpectedToolRow> };
};

function state() {
  g.__neoMemorySignals ??= { signals: new Map(), expectedTools: new Map() };
  return g.__neoMemorySignals;
}

export function resetMemorySignals(): void {
  g.__neoMemorySignals = undefined;
}

// ─── device_signals ────────────────────────────────────────────────

export interface MemoryInsertDeviceSignalInput {
  tenantId: string;
  deviceId: string;
  userId: string;
  clientEventId: string;
  type: string;
  detector: string;
  subject: string;
  payload: Record<string, unknown>;
  observedAt: Date;
  escalated?: boolean;
  now?: Date;
}

export function memoryInsertDeviceSignal(input: MemoryInsertDeviceSignalInput): { row: DeviceSignalRow; duplicate: boolean } {
  const signals = state().signals;
  for (const row of signals.values()) {
    if (row.deviceId === input.deviceId && row.clientEventId === input.clientEventId) return { row, duplicate: true };
  }
  const row: MemSignal = {
    id: crypto.randomUUID(),
    tenantId: input.tenantId,
    deviceId: input.deviceId,
    userId: input.userId,
    clientEventId: input.clientEventId,
    type: input.type,
    detector: input.detector,
    subject: input.subject,
    payload: input.payload,
    severity: null,
    outcome: "pending",
    escalated: input.escalated ?? false,
    verdictId: null,
    alertId: null,
    observedAt: input.observedAt,
    receivedAt: input.now ?? new Date(),
  };
  signals.set(row.id, row);
  return { row, duplicate: false };
}

export function memoryGetDeviceSignal(tenantId: string, id: string): DeviceSignalRow | undefined {
  const row = state().signals.get(id);
  return row && row.tenantId === tenantId ? row : undefined;
}

export interface MemoryUpdateDeviceSignalPatch {
  severity?: SignalSeverity | null;
  outcome?: SignalOutcome;
  verdictId?: string | null;
  alertId?: string | null;
}

export function memoryUpdateDeviceSignal(tenantId: string, id: string, patch: MemoryUpdateDeviceSignalPatch): DeviceSignalRow | undefined {
  const row = state().signals.get(id);
  if (!row || row.tenantId !== tenantId) return undefined;
  if (patch.severity !== undefined) row.severity = patch.severity;
  if (patch.outcome !== undefined) row.outcome = patch.outcome;
  if (patch.verdictId !== undefined) row.verdictId = patch.verdictId;
  if (patch.alertId !== undefined) row.alertId = patch.alertId;
  return row;
}

/** This device's rows among `clientEventIds` (status polling; _specs/browser-extension.md). Unknown ids omitted. */
export function memoryListDeviceSignalsByClientIds(tenantId: string, deviceId: string, clientEventIds: readonly string[]): DeviceSignalRow[] {
  const want = new Set(clientEventIds);
  return [...state().signals.values()].filter((r) => r.tenantId === tenantId && r.deviceId === deviceId && want.has(r.clientEventId));
}

/** A member's signals since `since`, oldest first (for correlation). */
export function memoryListRecentUserSignals(
  tenantId: string,
  userId: string,
  opts: { since: Date; outcomes?: readonly SignalOutcome[] },
): DeviceSignalRow[] {
  return [...state().signals.values()]
    .filter((r) => r.tenantId === tenantId && r.userId === userId && r.observedAt.getTime() >= opts.since.getTime())
    .filter((r) => !opts.outcomes?.length || opts.outcomes.includes(r.outcome))
    .sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
}

/** How many signals a device has received since `since` (received_at), for the daily rate limit. */
export function memoryCountDeviceSignalsSince(tenantId: string, deviceId: string, since: Date, opts: { escalatedOnly?: boolean } = {}): number {
  return [...state().signals.values()].filter(
    (r) => r.tenantId === tenantId && r.deviceId === deviceId && r.receivedAt.getTime() >= since.getTime() && (!opts.escalatedOnly || r.escalated),
  ).length;
}

/** Retention: rows older than 30 days by received_at. */
export function memoryPurgeOldDeviceSignals(now = new Date(), retentionDays = 30): number {
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  let n = 0;
  for (const [id, row] of state().signals) {
    if (row.receivedAt.getTime() < cutoff) {
      state().signals.delete(id);
      n++;
    }
  }
  return n;
}

// ─── device_expected_tools ─────────────────────────────────────────

function expectedKey(deviceId: string, toolId: string): string {
  return `${deviceId}:${toolId}`;
}

/** Expected remote-access tools for the household, or one device. Rows for devices outside `tenantId` are never returned. */
export function memoryListExpectedTools(tenantId: string, opts: { deviceId?: string } = {}): ExpectedToolRow[] {
  return [...state().expectedTools.values()]
    .filter((r) => opts.deviceId === undefined || r.deviceId === opts.deviceId)
    .filter((r) => memoryGetDevice(tenantId, r.deviceId) !== undefined);
}

export interface MemorySetExpectedToolsInput {
  tenantId: string;
  deviceId: string;
  tools: { toolId: string; peerIds: string[] }[];
  createdBy: string;
  now?: Date;
}

/** Replace a device's expected-tools set. Undefined when the device is unknown or revoked. */
export function memorySetExpectedTools(input: MemorySetExpectedToolsInput): ExpectedToolRow[] | undefined {
  const device = memoryGetDevice(input.tenantId, input.deviceId);
  if (!device || device.revokedAt) return undefined;
  const now = input.now ?? new Date();
  for (const key of [...state().expectedTools.keys()]) {
    if (key.startsWith(`${input.deviceId}:`)) state().expectedTools.delete(key);
  }
  const rows = input.tools.map((t): ExpectedToolRow => ({ deviceId: input.deviceId, toolId: t.toolId, peerIds: [...t.peerIds], createdBy: input.createdBy, createdAt: now }));
  for (const row of rows) state().expectedTools.set(expectedKey(row.deviceId, row.toolId), row);
  return rows;
}
