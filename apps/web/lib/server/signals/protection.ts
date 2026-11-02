/**
 * Per-member protection for the signal pipeline (_specs/v2-m1-elder.md §3): load the policy
 * layers (household, mode, member, device) once and merge them with the @neo/core
 * `effectivePolicy`. Any failure falls back to Standard (logged), so a policy lookup problem
 * never stops signals being processed.
 */
import { effectivePolicy, logger, type RecentSignal } from "@neo/core";
import { getProtectionLayers, tenantScoped } from "@neo/db";
import type { PolicyRules } from "@neo/verdict";
import { getDb } from "../db";
import { memoryMemberRecords, memoryProtection } from "../memory-members";
import type { DeviceSignalRow } from "./store";

export interface SignalProtection {
  policy: PolicyRules;
  memberId: string | null;
}

/** The device's member: the subject of its signals and alerts, with or without an account. */
export interface ProtectedSubject {
  memberId: string;
  userId: string | null;
}

export async function loadSignalProtection(tenantId: string, subject: ProtectedSubject, deviceId: string): Promise<SignalProtection> {
  try {
    const db = getDb();
    if (!db) {
      const mode = subject.userId
        ? memoryProtection(tenantId, subject.userId).mode
        : (memoryMemberRecords(tenantId).find((m) => m.id === subject.memberId)?.mode ?? "standard");
      return { policy: effectivePolicy({ mode }), memberId: subject.memberId };
    }
    const layers = await getProtectionLayers(tenantScoped(db, tenantId), { memberId: subject.memberId, deviceId });
    return { policy: effectivePolicy(layers as Parameters<typeof effectivePolicy>[0]), memberId: layers.memberId };
  } catch (err) {
    logger.error("Protection layers lookup failed; using Standard", "signals", { tenantId, errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
    return { policy: effectivePolicy({ mode: "standard" }), memberId: null };
  }
}

/** Stored rows → the engine's `RecentSignal` (payload carries `direction`/`discovery`). */
export function toRecentSignals(rows: readonly DeviceSignalRow[]): RecentSignal[] {
  return rows.map((r) => ({
    id: r.id,
    clientEventId: r.clientEventId,
    detector: r.detector,
    severity: r.severity,
    outcome: r.outcome,
    verdictId: r.verdictId,
    observedAt: r.observedAt,
    deviceId: r.deviceId,
    payload: r.payload,
  }));
}
