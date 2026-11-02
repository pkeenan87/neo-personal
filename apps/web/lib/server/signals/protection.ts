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
import { memoryProtection } from "../memory-members";
import type { DeviceSignalRow } from "./store";

export interface SignalProtection {
  policy: PolicyRules;
  memberId: string | null;
}

export async function loadSignalProtection(tenantId: string, userId: string, deviceId: string): Promise<SignalProtection> {
  try {
    const db = getDb();
    if (!db) {
      const m = memoryProtection(tenantId, userId);
      return { policy: effectivePolicy({ mode: m.mode }), memberId: m.memberId };
    }
    const layers = await getProtectionLayers(tenantScoped(db, tenantId), { userId, deviceId });
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
