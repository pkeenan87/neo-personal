/**
 * Apply an "alerted" rule outcome: save the verdict (when the rule produced one), raise the
 * household alert, patch the stored signal row, and check for a scam-in-progress correlation.
 * Shared by lib/server/signals/ingest.ts (synchronous rules) and
 * lib/server/signals/escalate.ts (once an escalation confirms), so both paths raise alerts and
 * verdicts identically. Kept separate from both to avoid a circular import (ingest queues
 * escalations; escalate applies outcomes).
 */
import { REMOTE_ACCESS_TOOLS, findRemoteAccessTool } from "@neo/tools";
import type { SignalEvent } from "@neo/verdict";
import type { SignalSeverity } from "@neo/db";
import type { AlertKindName } from "@/lib/alert-types";
import { alertScamInProgress, alertSignal, alertSignalBypass, tenantMembers, type SignalAlertKind } from "../alerts";
import {
  dangerousSiteAlertText,
  deviceLabel,
  displayName,
  permissionGrantAlertText,
  remoteAccessBaselineAlertText,
  remoteAccessInstallAlertText,
  remoteAccessSessionAlertText,
  scamPageAlertText,
  unwantedSoftwareAlertText,
  warningBypassedAlertText,
  type AlertText,
} from "../alerts/templates";
import { saveVerdict } from "../verdicts";
import { findScamInProgress, type CorrelationEvent, type RuleVerdictLabel } from "./rules";
import { listRecentUserSignals, updateDeviceSignal } from "./store";
import { buildSignalVerdict } from "./verdicts";

/** The subset of a device the signal pipeline needs, independent of the devices.ts wire mapper. */
export interface SignalDeviceInfo {
  id: string;
  tenantId: string;
  userId: string;
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
  now?: Date;
}

export interface AlertedSignalResult {
  verdictId?: string;
  alertId?: string;
}

/** Save the verdict (if any), raise the alert, patch the row, and check for correlation. */
export async function applyAlertedSignal(input: AlertedSignalInput): Promise<AlertedSignalResult> {
  const { device, event, severity, alertKind } = input;
  let verdictId: string | undefined;
  if (input.verdictLabel) {
    const verdict = buildSignalVerdict({ event, verdict: input.verdictLabel, severity, reasonCodes: input.reasonCodes, deviceName: device.name });
    const saved = await saveVerdict({ tenantId: device.tenantId, userId: device.userId, source: "device", verdict });
    verdictId = saved.id;
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
      })
    : await alertSignal({ tenantId: device.tenantId, userId: device.userId, deviceId: device.id, kind: alertKind, detector: event.detector, subject: input.subject, verdictId, text, now: input.now });

  await updateDeviceSignal(device.tenantId, input.rowId, { severity, outcome: "alerted", verdictId: verdictId ?? null, alertId: alertRow?.id ?? null });
  await checkScamInProgress(device.tenantId, device.userId, input.now);
  return { verdictId, alertId: alertRow?.id ?? undefined };
}

const SCAM_LOOKBACK_MS = 60 * 60 * 1000; // wider than the 30-minute correlation window, so a pair straddling it is still found

/** Detector → correlation alert kind (mirrors lib/server/signals/rules.ts's PAGE/remote_access mapping, for stored rows). */
function correlationKind(detector: SignalEvent["detector"]): AlertKindName | undefined {
  if (detector === "tech_support_scam") return "scam_page";
  if (detector === "lookalike_login" || detector === "dangerous_site") return "dangerous_site";
  if (detector === "remote_tool_download" || detector === "remote_access_tool" || detector === "remote_access_session") return "remote_access";
  return undefined;
}

const EVENT_LABEL: Partial<Record<AlertKindName, string>> = {
  scam_page: "a tech-support scam page was opened",
  dangerous_site: "a dangerous or fake-login page was opened",
  remote_access: "a remote-access event happened",
};

/**
 * Re-check the member's alerted signals for a scam-in-progress correlation (any of their
 * devices, 30 minutes). Safe to call after every alerted event: `raiseAlert`'s dedupe key makes
 * a repeat call a no-op once the alert exists.
 */
export async function checkScamInProgress(tenantId: string, userId: string, now = new Date()): Promise<void> {
  const rows = await listRecentUserSignals(tenantId, userId, { since: new Date(now.getTime() - SCAM_LOOKBACK_MS), outcomes: ["alerted"] });
  const events: CorrelationEvent[] = [];
  for (const r of rows) {
    const kind = correlationKind(r.detector as SignalEvent["detector"]);
    if (!kind || !r.severity) continue;
    // A tool already installed at enrollment is not evidence of a call happening now.
    if (r.detector === "remote_access_tool" && r.payload.discovery === "baseline") continue;
    events.push({ id: r.id, deviceId: r.deviceId, kind, severity: r.severity, observedAt: r.observedAt });
  }
  const found = findScamInProgress(events);
  if (!found) return;
  const members = await tenantMembers(tenantId);
  const member = members.find((m) => m.userId === userId);
  const memberName = displayName(member?.name ?? null, member?.email ?? null);
  const body = [
    `Neo saw a scam warning and a remote-access event close together for ${memberName}:`,
    ...found.events.map((e) => `${e.observedAt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" })} UTC — ${EVENT_LABEL[e.kind] ?? "an event happened"}`),
  ].join("\n");
  await alertScamInProgress({
    tenantId,
    userId,
    bucket: found.bucket,
    text: { severity: "critical", title: `${memberName} may be on a scam call right now`, body },
  });
}
