/**
 * The `end_session` eve tool's logic (_specs/v2-m3-cutover.md section 4). Imports nothing from Next, so
 * the eve server can bundle it.
 *
 * - The caller (tenant, user) is the verified eve caller, never tool input. The household role is re-read
 *   from the database by `requireHouseholdAdmin`.
 * - The device, the tool and the remote ID come from the incident's stored `remote_access_session` signals
 *   (`alerts.signal_ids`), never from the model.
 * - It only *requests*: the command goes into the device's signed policy bundle and the device answers
 *   with a `command_result` (device-commands.ts). Nothing here, and nothing the tool returns, says the
 *   session ended.
 * - Confirmation rule: the person at the device confirms on screen unless the device's member is in Child
 *   mode. An Elder always confirms (owner decision); so does anyone else, including the owner's own
 *   computer (the safer reading; see Open Questions in the spec).
 * - Postgres only: without DATABASE_URL (the eve process always has it) every lookup is a miss.
 */
import { logger } from "@neo/core";
import { alerts, createDeviceCommand, deviceSignals, getProtectionLayers, recordIncidentAction, tenantScoped, type AlertRow, type DeviceSignalRow } from "@neo/db";
import { findRemoteAccessTool } from "@neo/tools";
import { eq, inArray } from "drizzle-orm";
import { recordAudit } from "./audit";
import { getDb } from "./db";
import { getDevice } from "./devices";
import { requireHouseholdAdmin } from "./household-admin";
import { isUuid, type IncidentCaller } from "./incident-data";
import { takeRateSlot } from "./rate-limit";

/** The device must have been in contact (a heartbeat or a policy fetch) within this long. */
export const END_SESSION_LIVE_WITHIN_MS = 10 * 60 * 1000;
/** Requests per device and hour. */
export const END_SESSION_LIMIT = { limit: 6, windowMs: 60 * 60 * 1000 } as const;

export type EndSessionError = "not_found" | "not_allowed" | "already_closed" | "no_session" | "not_supported" | "device_offline" | "rate_limited" | "failed";

export type EndSessionResult =
  | { ok: true; action: "end_session"; incidentId: string; commandId: string; status: "requested"; requiresConfirmation: boolean; message: string }
  | { ok: false; error: EndSessionError; message?: string };

const NOT_FOUND = { ok: false, error: "not_found" } as const;

/** The incoming remote session behind an incident, from its own signals; newest first. */
function deriveSession(alert: AlertRow, signals: DeviceSignalRow[]): { toolId: string; peerId?: string } | undefined {
  const sessions = signals
    .filter((s) => s.deviceId === alert.deviceId && s.detector === "remote_access_session" && s.payload.direction !== "outgoing" && typeof s.payload.toolId === "string")
    .sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime());
  const pick = sessions[0];
  if (!pick) return undefined;
  const peer = typeof pick.payload.peerId === "string" && pick.payload.peerId.length > 0 ? pick.payload.peerId : undefined;
  return { toolId: pick.payload.toolId as string, ...(peer ? { peerId: peer } : {}) };
}

const minutesAgo = (from: Date, now: Date): number => Math.max(0, Math.round((now.getTime() - from.getTime()) / 60_000));

/** Ask the device of an incident to end its remote session. See the file header for the contract. */
export async function requestEndSession(caller: IncidentCaller, incidentId: string, now = new Date()): Promise<EndSessionResult> {
  const db = getDb();
  if (!db) return NOT_FOUND;
  let attempted: string | undefined;
  try {
    const admin = await requireHouseholdAdmin(caller);
    if (!admin.ok) return { ok: false, error: "not_allowed", message: admin.message };
    if (!isUuid(incidentId)) return NOT_FOUND;
    const t = tenantScoped(db, caller.tenantId);
    const alert = await t.first(alerts, eq(alerts.id, incidentId));
    if (!alert) return NOT_FOUND;
    attempted = alert.id;
    if (alert.status === "resolved" || alert.status === "false_positive") return { ok: false, error: "already_closed", message: "This alert is already closed." };

    const record = async (status: "pending" | "failed", result: Record<string, unknown>) => {
      try {
        await recordIncidentAction(db, caller.tenantId, { alertId: alert.id, kind: "end_session", requestedBy: "agent", approvedBy: caller.userId, status, result });
      } catch (err) {
        logger.error("Incident action row failed", "incidents", { tenantId: caller.tenantId, errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
      }
      await recordAudit(caller.tenantId, caller.userId, "incident.action", { alertId: alert.id, kind: "end_session", status });
    };
    const refuse = async (error: EndSessionError, message: string): Promise<EndSessionResult> => {
      await record("failed", { reason: error });
      return { ok: false, error, message };
    };

    if (alert.kind !== "remote_access" || !alert.deviceId) return refuse("no_session", "This alert isn't about a remote session.");
    const signals = alert.signalIds.length > 0 ? await t.select(deviceSignals, inArray(deviceSignals.id, alert.signalIds)) : [];
    const session = deriveSession(alert, signals);
    const tool = session ? findRemoteAccessTool(session.toolId) : undefined;
    if (!session || !tool) return refuse("no_session", "This alert doesn't show a remote session that is still open to end.");

    const device = await getDevice(caller.tenantId, alert.deviceId);
    if (!device || device.revokedAt || !device.memberId || device.kind !== "desktop_agent") {
      return refuse("not_supported", "Neo can only end a session on a computer that has the Neo desktop app, and that computer is not available.");
    }
    const lastContact = device.lastSeenAt ?? device.createdAt;
    if (now.getTime() - lastContact.getTime() > END_SESSION_LIVE_WITHIN_MS) {
      return refuse("device_offline", `That computer last checked in ${minutesAgo(lastContact, now)} minutes ago, so Neo can't reach it right now. Nothing was sent.`);
    }
    const slot = takeRateSlot("end-session", device.id, END_SESSION_LIMIT.limit, END_SESSION_LIMIT.windowMs, now.getTime());
    if (!slot.ok) return refuse("rate_limited", "Neo has already tried to end sessions on that computer several times this hour. Try again later.");

    // The person there confirms on screen unless the device's member is in Child mode.
    const layers = await getProtectionLayers(t, { memberId: device.memberId, deviceId: device.id });
    const requiresConfirmation = layers.mode !== "child";

    const { command, existing } = await createDeviceCommand(db, caller.tenantId, {
      deviceId: device.id,
      alertId: alert.id,
      kind: "end_session",
      payload: { toolId: session.toolId, ...(session.peerId ? { peerId: session.peerId } : {}) },
      requiresConfirmation,
      requestedBy: caller.userId,
      now,
    });
    if (!existing) await record("pending", { commandId: command.id, toolId: session.toolId, requiresConfirmation });

    const who = device.memberName ?? "the person at that computer";
    const deviceName = device.name;
    const message = existing
      ? `Already requested: ${tool.name} on ${deviceName} is waiting for ${command.requiresConfirmation ? `${who} to confirm on screen` : "the computer to pick up the request"}. Nothing has ended yet.`
      : requiresConfirmation
        ? `Requested. Neo asked ${who} to confirm on screen that ${tool.name} should be closed on ${deviceName}. Waiting for ${who} to confirm; nothing has ended yet. The request runs out in 10 minutes.`
        : `Requested. ${deviceName} will close ${tool.name} within about a minute. Nothing has ended yet; Neo will update this alert when the computer answers.`;
    return { ok: true, action: "end_session", incidentId: alert.id, commandId: command.id, status: "requested", requiresConfirmation: command.requiresConfirmation, message };
  } catch (err) {
    logger.error("End session failed", "incidents", { tenantId: caller.tenantId, errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
    if (attempted) {
      await recordIncidentAction(db, caller.tenantId, { alertId: attempted, kind: "end_session", requestedBy: "agent", approvedBy: caller.userId, status: "failed", result: { reason: "error" } }).catch(() => undefined);
      await recordAudit(caller.tenantId, caller.userId, "incident.action", { alertId: attempted, kind: "end_session", status: "failed" });
    }
    return { ok: false, error: "failed", message: "That didn't work, so nothing was sent. Check the alert before trying again." };
  }
}
