/**
 * Commands the server sends to a device (_specs/v2-m3-cutover.md section 4): the storage side (what the
 * policy bundle carries) and the device's answer (`command_result`). Imports nothing from Next, so the
 * eve server can bundle it.
 *
 * - Postgres only. Without DATABASE_URL there is no command queue: the bundle carries none and a
 *   `command_result` is refused (the eve process, which creates commands, always has a database).
 * - A device answers only its own command, once. The answer closes the command, appends an
 *   `incident_actions` row, resolves the incident when the session was ended, and is audited.
 * - What the device says is stored only as an `outcome` and a known `detail` code: a compromised device
 *   cannot put text into an alert or a chat.
 */
import { logger } from "@neo/core";
import {
  completeDeviceCommand,
  expireDeviceCommands as dbExpireDeviceCommands,
  failExpiredCommandAction,
  getDeviceCommand,
  listExpiredDeviceCommands as dbListExpiredDeviceCommands,
  listOpenDeviceCommands,
  markDeviceCommandsDelivered,
  recordIncidentAction,
  resolveAlert,
  type DeviceCommandRow,
} from "@neo/db";
import type { BundleCommand, CommandOutcome } from "@neo/verdict";
import { recordAudit } from "./audit";
import { getDb } from "./db";

/** The detail codes the agent may report for `end_session`; anything else is dropped (the stored result holds only known codes). */
export const END_SESSION_DETAILS: ReadonlySet<string> = new Set(["closed", "not_running", "protected", "close_failed", "tray_unavailable", "not_supported", "no_answer", "kept"]);

/** The command as the policy bundle carries it. */
export function toBundleCommand(row: DeviceCommandRow): BundleCommand {
  return {
    id: row.id,
    kind: row.kind,
    sessionRef: { toolId: row.payload.toolId, ...(row.payload.peerId ? { peerId: row.payload.peerId } : {}) },
    requiresConfirmation: row.requiresConfirmation,
    expiresAt: row.expiresAt.toISOString(),
  };
}

/** The device's open, unexpired commands. Empty without a database. */
export async function listBundleCommands(tenantId: string, deviceId: string, now = new Date()): Promise<BundleCommand[]> {
  const db = getDb();
  if (!db) return [];
  return (await listOpenDeviceCommands(db, tenantId, deviceId, now)).map(toBundleCommand);
}

/** Marks the commands a device has just been served as delivered. Best effort: never fails the policy response. */
export async function markCommandsDelivered(tenantId: string, ids: readonly string[]): Promise<void> {
  const db = getDb();
  if (!db || ids.length === 0) return;
  try {
    await markDeviceCommandsDelivered(db, tenantId, ids);
  } catch (err) {
    logger.error("Marking commands delivered failed", "devices", { tenantId, errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
  }
}

export type CommandResultOutcome = "applied" | "duplicate" | "rejected";

const STATUS_FOR_OUTCOME = { done: "done", declined: "declined", failed: "failed", expired: "expired" } as const satisfies Record<CommandOutcome, string>;

/**
 * Apply a `command_result` from `deviceId`. `rejected` when the command does not exist, belongs to another device or
 * household, or the database is unavailable; `duplicate` when it is already finished (a retried batch or a second
 * answer changes nothing).
 */
export async function applyCommandResult(input: { tenantId: string; deviceId: string; commandId: string; outcome: CommandOutcome; detail?: string; now?: Date }): Promise<CommandResultOutcome> {
  const db = getDb();
  if (!db) return "rejected";
  const now = input.now ?? new Date();
  const existing = await getDeviceCommand(db, input.tenantId, input.commandId);
  if (!existing || existing.deviceId !== input.deviceId) return "rejected";
  const detail = input.detail && END_SESSION_DETAILS.has(input.detail) ? input.detail : undefined;
  const closed = await completeDeviceCommand(db, input.tenantId, {
    id: existing.id,
    deviceId: input.deviceId,
    status: STATUS_FOR_OUTCOME[input.outcome],
    result: { outcome: input.outcome, ...(detail ? { detail } : {}) },
    now,
  });
  if (!closed) return "duplicate";

  if (closed.alertId) {
    const approver = closed.requestedBy;
    try {
      await recordIncidentAction(db, input.tenantId, {
        alertId: closed.alertId,
        kind: "end_session",
        requestedBy: "agent",
        approvedBy: approver,
        status: input.outcome === "done" ? "done" : input.outcome === "failed" ? "failed" : "rejected",
        result: { commandId: closed.id, outcome: input.outcome, ...(detail ? { detail } : {}), ...(closed.requiresConfirmation && input.outcome === "done" ? { confirmed: true } : {}) },
      });
      // The session the incident reports is over: close it. Anything else leaves the incident open for the owner.
      if (input.outcome === "done" && approver) await resolveAlert(db, input.tenantId, closed.alertId, "resolved", approver, now);
    } catch (err) {
      logger.error("Recording a command result on the incident failed", "devices", { tenantId: input.tenantId, errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
    }
  }
  await recordAudit(input.tenantId, closed.requestedBy, "device.command_result", { commandId: closed.id, deviceId: input.deviceId, kind: closed.kind, outcome: input.outcome, ...(detail ? { detail } : {}) });
  return "applied";
}

// ---- Expiry (the 5-minute `outbox-sweep`) -------------------------------------------------------

/** Open commands past their expiry, across households (the shadow plan). Empty without a database. */
export async function listExpiredCommands(now: Date): Promise<{ id: string; tenantId: string }[]> {
  const db = getDb();
  return db ? dbListExpiredDeviceCommands(db, now) : [];
}

/**
 * Marks every open command past its expiry `expired`, settles the pending `end_session` action of each as
 * `failed` with `reason: "expired"` (so `get_incident` says the device did not respond) and audits it.
 * One command failing to settle never stops the others. Returns how many commands were expired.
 */
export async function expireStaleCommands(now: Date): Promise<number> {
  const db = getDb();
  if (!db) return 0;
  const expired = await dbExpireDeviceCommands(db, now);
  for (const c of expired) {
    try {
      if (c.alertId) await failExpiredCommandAction(db, c.tenantId, { alertId: c.alertId, commandId: c.id, now });
      await recordAudit(c.tenantId, null, "device.command_expired", { commandId: c.id, ...(c.alertId ? { alertId: c.alertId } : {}) });
    } catch (err) {
      logger.error("Settling an expired command failed", "devices", { tenantId: c.tenantId, errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
    }
  }
  return expired.length;
}

/** A stored `end_session` action in plain words, from fixed wording keyed by its status and result codes (never stored text). */
export function describeEndSessionAction(status: string, result: unknown): string {
  const r = (result && typeof result === "object" ? result : {}) as { outcome?: unknown; reason?: unknown; detail?: unknown };
  if (status === "pending") return "A request to end the remote session was sent. Waiting for the device to answer.";
  if (r.reason === "expired" || r.outcome === "expired") return "The request to end the session expired — the device didn't respond.";
  if (status === "done") return r.detail === "not_running" ? "The remote program was no longer running on the device." : "The device ended the remote session.";
  if (status === "rejected") return "The request to end the session was not carried out: the person at the device chose to keep it, or did not answer.";
  const refusals: Record<string, string> = {
    device_offline: "The request to end the session was not sent: Neo couldn't reach the device.",
    no_session: "The request to end the session was not sent: the alert shows no open remote session.",
    not_supported: "The request to end the session was not sent: the device can't be asked.",
    rate_limited: "The request to end the session was not sent: too many requests for that device.",
  };
  if (typeof r.reason === "string" && r.reason in refusals) return refusals[r.reason]!;
  return r.outcome === "failed" ? "The device could not end the remote session." : "The request to end the session did not go through.";
}
