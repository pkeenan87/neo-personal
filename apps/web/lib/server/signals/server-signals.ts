/**
 * Server-originated signals (_specs/v2-m1-elder.md §4 rule 5): things Neo itself observes about a
 * device rather than the device reporting them. Today that is `protection_disabled` (the
 * browser extension uninstall beacon, a device gone offline). They run through the same
 * policy engine as device signals and are not stored in `device_signals` (their detector is not
 * one of the device detectors); an `incident` decision raises the alert directly.
 */
import { evaluateSignal, logger } from "@neo/core";
import type { DevicePublic } from "@neo/db";
import type { ProtectionDisabledReason, ServerSignalEvent } from "@neo/verdict";
import { alertProtectionDisabled, tenantMembers } from "../alerts";
import { deviceLabel, displayName, protectionDisabledAlertText } from "../alerts/templates";
import { loadSignalProtection } from "./protection";
import { ENGINE_CATALOG } from "./rules";

/**
 * Evaluate a `protection_disabled` signal for the device's member under their effective policy
 * and raise the alert when the policy says it is an incident (Standard: record only, so no alert).
 * Never throws. Returns whether an alert was newly raised.
 */
export async function recordServerSignal(device: Pick<DevicePublic, "id" | "tenantId" | "userId" | "name">, reason: ProtectionDisabledReason, now = new Date()): Promise<boolean> {
  try {
    const { policy, memberId } = await loadSignalProtection(device.tenantId, device.userId, device.id);
    const event: ServerSignalEvent = { id: crypto.randomUUID(), detector: "protection_disabled", reason, observedAt: now.toISOString() };
    const decision = evaluateSignal(policy, { event }, { now, deviceId: device.id, expectedTools: [], recent: [], catalog: ENGINE_CATALOG });
    if (decision.action !== "incident" || decision.kind !== "protection_disabled" || !decision.severity) return false;
    const member = (await tenantMembers(device.tenantId)).find((m) => m.userId === device.userId);
    const text = protectionDisabledAlertText(displayName(member?.name ?? null, member?.email ?? null), deviceLabel(device.name), reason, decision.severity);
    const row = await alertProtectionDisabled({ tenantId: device.tenantId, userId: device.userId, deviceId: device.id, text, memberId, now });
    return row !== null;
  } catch (err) {
    logger.error("Server signal failed", "signals", { tenantId: device.tenantId, errorType: reason, errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
    return false;
  }
}
