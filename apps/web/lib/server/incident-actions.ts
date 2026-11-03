/**
 * The two acting eve tools' logic, `mark_expected` and `allow_once` (_specs/v2-m1-elder.md section 8).
 * Imports nothing from Next, so the eve server can bundle it.
 *
 * - The caller (tenant, user) is the verified eve caller, never tool input. The household role is
 *   re-read from the database by `requireHouseholdAdmin`; the role the caller carries is ignored.
 * - The tool and the remote ID for `mark_expected` come from the incident's stored device signals
 *   (`alerts.signal_ids`), never from the model.
 * - Every attempt that gets past the admin check and finds the incident leaves an `incident_actions`
 *   row (`done` or `failed`) and an `incident.action` audit event. Nothing here claims success unless
 *   the change was stored.
 * - Postgres only: without DATABASE_URL (the eve process always has it) every lookup is a miss.
 */
import { logger } from "@neo/core";
import { alerts, deviceSignals, recordIncidentAction, resolveAlert, tenantScoped, type AlertRow, type DeviceSignalRow } from "@neo/db";
import { eq, inArray } from "drizzle-orm";
import { recordAudit } from "./audit";
import { getDb } from "./db";
import { requireHouseholdAdmin } from "./household-admin";
import { isUuid, type IncidentCaller } from "./incident-data";
import { addDeviceExpectedTool } from "./signals/expected-tools";

export type IncidentActionName = "mark_expected" | "allow_once";

export const NOTE_MAX = 200;

export type IncidentActionResult =
  | { ok: true; action: IncidentActionName; incidentId: string; status: "resolved" | "false_positive"; message: string }
  | { ok: false; error: "not_found" | "not_allowed" | "already_closed" | "not_remote_access" | "failed"; message?: string };

const NOT_FOUND = { ok: false, error: "not_found" } as const;

const clean = (s: string | undefined): string | undefined => {
  // eslint-disable-next-line no-control-regex
  const v = (s ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return v ? [...v].slice(0, NOTE_MAX).join("") : undefined;
};

interface Derived {
  toolId: string;
  peerId?: string;
}

/** The remote-access tool (and the remote ID that connected) behind an incident, from its own signals. Newest session first. */
function deriveRemoteTool(alert: AlertRow, signals: DeviceSignalRow[]): Derived | undefined {
  const mine = signals
    .filter((s) => s.deviceId === alert.deviceId && typeof s.payload.toolId === "string" && s.payload.toolId.length > 0)
    .sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime());
  const session = mine.find((s) => s.detector === "remote_access_session");
  const pick = session ?? mine[0];
  if (!pick) return undefined;
  const peer = session && typeof session.payload.peerId === "string" && session.payload.peerId.length > 0 ? session.payload.peerId : undefined;
  return { toolId: pick.payload.toolId as string, ...(peer ? { peerId: peer } : {}) };
}

/** Run one action for an incident of the caller's household. See the file header for the contract. */
export async function performIncidentAction(
  caller: IncidentCaller,
  action: IncidentActionName,
  incidentId: string,
  opts: { note?: string } = {},
): Promise<IncidentActionResult> {
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
    if (alert.status === "resolved" || alert.status === "false_positive") {
      return { ok: false, error: "already_closed", message: "This alert is already closed." };
    }

    const record = async (status: "done" | "failed", result: Record<string, unknown>) => {
      try {
        await recordIncidentAction(db, caller.tenantId, { alertId: alert.id, kind: action, requestedBy: "agent", approvedBy: caller.userId, status, result });
      } catch (err) {
        logger.error("Incident action row failed", "incidents", { tenantId: caller.tenantId, errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
      }
      await recordAudit(caller.tenantId, caller.userId, "incident.action", { alertId: alert.id, kind: action, status });
    };
    const refuse = async (error: "not_remote_access" | "failed" | "already_closed", message: string): Promise<IncidentActionResult> => {
      await record("failed", { reason: error, message });
      return { ok: false, error, message };
    };

    if (action === "mark_expected") {
      if (alert.kind !== "remote_access" || !alert.deviceId) {
        return refuse("not_remote_access", "This alert isn't about a remote-access tool.");
      }
      const signals = alert.signalIds.length > 0 ? await t.select(deviceSignals, inArray(deviceSignals.id, alert.signalIds)) : [];
      const derived = deriveRemoteTool(alert, signals);
      if (!derived) return refuse("not_remote_access", "This alert isn't about a remote-access tool.");
      const added = await addDeviceExpectedTool(caller, alert.deviceId, derived.toolId, derived.peerId);
      if (!added.ok) return refuse("failed", `${added.message} Nothing was changed.`);
      const closed = await resolveAlert(db, caller.tenantId, alert.id, "false_positive", caller.userId);
      if (!closed) return refuse("already_closed", "This alert was closed by someone else just now.");
      await record("done", { toolId: added.toolId, peerSaved: added.peerSaved });
      return {
        ok: true,
        action,
        incidentId: alert.id,
        status: "false_positive",
        message: `${added.toolName} is now an expected tool on that device${added.peerSaved ? ", for that remote ID" : ""}. The alert is closed as a false alarm.`,
      };
    }

    const closed = await resolveAlert(db, caller.tenantId, alert.id, "resolved", caller.userId);
    if (!closed) return refuse("already_closed", "This alert was closed by someone else just now.");
    const note = clean(opts.note);
    await record("done", note ? { note } : {});
    return { ok: true, action, incidentId: alert.id, status: "resolved", message: "The alert is closed as handled. No settings were changed." };
  } catch (err) {
    logger.error("Incident action failed", "incidents", { tenantId: caller.tenantId, errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
    if (attempted) {
      await recordIncidentAction(db, caller.tenantId, { alertId: attempted, kind: action, requestedBy: "agent", approvedBy: caller.userId, status: "failed", result: { reason: "error" } }).catch(() => undefined);
      await recordAudit(caller.tenantId, caller.userId, "incident.action", { alertId: attempted, kind: action, status: "failed" });
    }
    return { ok: false, error: "failed", message: "That didn't work, so nothing was confirmed. Check the alert before trying again." };
  }
}
