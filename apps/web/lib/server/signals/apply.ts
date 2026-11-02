/**
 * Apply an "alerted" rule outcome: save the verdict (when the rule produced one), raise the
 * household alert, patch the stored signal row, and check for a scam-in-progress correlation.
 * Shared by lib/server/signals/ingest.ts (synchronous rules) and
 * lib/server/signals/escalate.ts (once an escalation confirms), so both paths raise alerts and
 * verdicts identically. Kept separate from both to avoid a circular import (ingest queues
 * escalations; escalate applies outcomes).
 */
import type { Correlation } from "@neo/core";
import { REMOTE_ACCESS_TOOLS, findRemoteAccessTool } from "@neo/tools";
import type { SignalEvent } from "@neo/verdict";
import type { SignalSeverity } from "@neo/db";
import { alertCorrelation, alertScamInProgress, alertSignal, alertSignalBypass, tenantMembers, type SignalAlertKind } from "../alerts";
import {
  dangerousSiteAlertText,
  deviceLabel,
  displayName,
  installDuringSessionAlertText,
  paymentPageAlertText,
  paymentUnderPressureAlertText,
  permissionGrantAlertText,
  remoteAccessBaselineAlertText,
  remoteAccessInstallAlertText,
  remoteAccessSessionAlertText,
  scamInProgressAlertText,
  scamPageAlertText,
  unwantedSoftwareAlertText,
  warningBypassedAlertText,
  type AlertText,
} from "../alerts/templates";
import { saveVerdict } from "../verdicts";
import type { RuleVerdictLabel } from "./rules";
import { updateDeviceSignal } from "./store";
import { buildSignalVerdict } from "./verdicts";

/** The subset of a device the signal pipeline needs, independent of the devices.ts wire mapper. */
export interface SignalDeviceInfo {
  id: string;
  tenantId: string;
  /** The member the device protects: the subject of its signals and alerts. */
  memberId: string;
  /** The member's account; null for a member without one. */
  userId: string | null;
  name: string;
  memberName: string | null;
}

function isRemoteAccessBundle(bundleId: string | undefined): boolean {
  if (!bundleId) return false;
  const needle = bundleId.toLowerCase();
  return REMOTE_ACCESS_TOOLS.some((t) => t.macos.bundleIds.some((b) => b.toLowerCase() === needle));
}

function toolDisplayName(toolId: string, fallback: string): string {
  return findRemoteAccessTool(toolId)?.name ?? fallback;
}

/** Build the alert title/body for one event, given its resolved severity. The event's own detector picks the template. */
export function alertTextFor(event: SignalEvent, ctx: { memberName: string; deviceLbl: string; severity: SignalSeverity }): AlertText {
  const { memberName, deviceLbl, severity } = ctx;
  switch (event.detector) {
    case "tech_support_scam":
      return scamPageAlertText(memberName, deviceLbl);
    case "lookalike_login":
      return dangerousSiteAlertText(memberName, deviceLbl, event.domain, event.brand);
    case "dangerous_site":
      return dangerousSiteAlertText(memberName, deviceLbl, event.domain, null);
    case "remote_tool_download":
      return remoteAccessInstallAlertText(deviceLbl, toolDisplayName(event.toolId, event.fileName), event.domain);
    case "remote_access_tool":
      return event.discovery === "baseline"
        ? remoteAccessBaselineAlertText(deviceLbl, toolDisplayName(event.toolId, event.name), severity)
        : remoteAccessInstallAlertText(deviceLbl, toolDisplayName(event.toolId, event.name), null, severity);
    case "unwanted_software":
      return unwantedSoftwareAlertText(deviceLbl, event.name, event.reason === "unsigned_unknown");
    case "remote_access_session":
      return remoteAccessSessionAlertText(deviceLbl, toolDisplayName(event.toolId, "a remote-access tool"), event.peerId ?? null, severity);
    case "tcc_grant":
      return permissionGrantAlertText(deviceLbl, event.app, event.service, isRemoteAccessBundle(event.bundleId));
    case "warning_bypassed":
      return warningBypassedAlertText(memberName, deviceLbl);
    case "payment_page":
      return paymentPageAlertText(memberName, deviceLbl, event.category);
    default:
      return { severity: "low", title: `${deviceLbl}: Neo flagged an event`, body: `Neo flagged an event on ${deviceLbl}.` };
  }
}

export interface AlertedSignalInput {
  device: SignalDeviceInfo;
  event: SignalEvent;
  rowId: string;
  subject: string;
  severity: SignalSeverity;
  verdictLabel: RuleVerdictLabel | null;
  alertKind: SignalAlertKind;
  reasonCodes: string[];
  bypassOf?: { relatesTo: string; relatedVerdictId: string | null };
  /** The protected member row (v2); null when unknown. */
  memberId?: string | null;
  /** Correlated incidents the policy engine says this signal completes; one alert each. */
  correlations?: readonly Correlation[];
  now?: Date;
}

export interface AlertedSignalResult {
  verdictId?: string;
  alertId?: string;
}

/** Save the verdict (if any), raise the alert, patch the row, and raise any correlated alerts. */
export async function applyAlertedSignal(input: AlertedSignalInput): Promise<AlertedSignalResult> {
  const { device, event, severity, alertKind } = input;
  let verdictId: string | undefined;
  if (input.verdictLabel) {
    // Verdicts belong to a signed-in user (verdicts.user_id); a member without an account has none,
    // so the alert is raised without one (the signal row and the alert still carry the evidence).
    if (device.userId) {
      const verdict = buildSignalVerdict({ event, verdict: input.verdictLabel, severity, reasonCodes: input.reasonCodes, deviceName: device.name });
      const saved = await saveVerdict({ tenantId: device.tenantId, userId: device.userId, source: "device", verdict });
      verdictId = saved.id;
    }
  }
  const memberName = displayName(device.memberName, null);
  const deviceLbl = deviceLabel(device.name);
  const text = alertTextFor(event, { memberName, deviceLbl, severity });

  const alertRow = input.bypassOf
    ? await alertSignalBypass({
        tenantId: device.tenantId,
        userId: device.userId,
        deviceId: device.id,
        kind: alertKind,
        relatesTo: input.bypassOf.relatesTo,
        verdictId: verdictId ?? input.bypassOf.relatedVerdictId,
        text,
        memberId: input.memberId ?? device.memberId,
        signalIds: [input.rowId],
      })
    : await alertSignal({
        tenantId: device.tenantId,
        userId: device.userId,
        deviceId: device.id,
        kind: alertKind,
        detector: event.detector,
        subject: input.subject,
        verdictId,
        text,
        memberId: input.memberId ?? device.memberId,
        signalIds: [input.rowId],
        now: input.now,
      });

  await updateDeviceSignal(device.tenantId, input.rowId, { severity, outcome: "alerted", verdictId: verdictId ?? null, alertId: alertRow?.id ?? null });
  await raiseCorrelations(device, input.memberId ?? device.memberId, input.correlations ?? []);
  return { verdictId, alertId: alertRow?.id ?? undefined };
}

const EVENT_LABEL: Partial<Record<string, string>> = {
  scam_page: "a tech-support scam page was opened",
  dangerous_site: "a dangerous or fake-login page was opened",
  remote_access: "a remote-access event happened",
};

/**
 * Raise one alert per correlation the policy engine returned (the engine owns correlation).
 * Safe to repeat: each alert's dedupe key (`<kind>:<userId>:<30-minute bucket>`, or
 * `<kind>:m:<memberId>:<bucket>` for a member without an account) makes a repeat a no-op.
 */
export async function raiseCorrelations(device: SignalDeviceInfo, memberId: string | null | undefined, correlations: readonly Correlation[]): Promise<void> {
  if (correlations.length === 0) return;
  const member = device.userId ? (await tenantMembers(device.tenantId)).find((m) => m.userId === device.userId) : undefined;
  const memberName = displayName(member?.name ?? device.memberName, member?.email ?? null);
  const deviceLbl = deviceLabel(device.name);
  const common = { tenantId: device.tenantId, userId: device.userId, bucket: "", memberId: memberId ?? device.memberId };
  for (const c of correlations) {
    const args = { ...common, bucket: c.bucket, signalIds: c.signalIds };
    if (c.kind === "scam_in_progress") {
      await alertScamInProgress({ ...args, text: scamInProgressAlertText(memberName, c.events.map((e) => ({ at: e.observedAt, label: EVENT_LABEL[e.kind] ?? "an event happened" }))) });
    } else if (c.kind === "install_during_session") {
      await alertCorrelation({ ...args, kind: c.kind, text: installDuringSessionAlertText(memberName, deviceLbl) });
    } else {
      await alertCorrelation({ ...args, kind: c.kind, text: paymentUnderPressureAlertText(memberName, deviceLbl) });
    }
  }
}
