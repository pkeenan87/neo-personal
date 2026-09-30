/**
 * GET /api/signals/status (_specs/browser-extension.md "Signal status"): the extension polls
 * this for an event it sent with `pending: true` (a lookalike-login escalation), until the
 * escalation resolves or the poll window ends. Scope and device-id checks live in the route;
 * this is the query itself: 1-50 client event ids, this device's rows only, unknown ids
 * omitted, 120 requests/hour/device.
 */
import type { SignalStatusResponse, SignalStatusResult } from "@/lib/signal-types";
import type { NeoSession } from "@/lib/session";
import type { Outcome } from "../household";
import { takeRateSlot } from "../rate-limit";
import { listDeviceSignalsByClientIds, type DeviceSignalRow } from "./store";

const HOUR_MS = 60 * 60 * 1000;
export const SIGNAL_STATUS_LIMIT = { limit: 120, windowMs: HOUR_MS } as const;
const MAX_IDS = 50;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(status: number, code: string, message: string): Outcome<never> {
  return { ok: false, status, code, message };
}

function rateLimited(retryAfterSeconds: number): Outcome<never> {
  return { ok: false, status: 429, code: "rate_limited", message: "Too many requests. Please try again later.", retryAfterSeconds };
}

/** `ids=<uuid>,<uuid>`, 1-50 well-formed uuids, else null (400 bad_request). */
function parseIds(raw: string | null): string[] | null {
  if (!raw) return null;
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length < 1 || ids.length > MAX_IDS || !ids.every((id) => UUID_RE.test(id))) return null;
  return ids;
}

function toResult(row: DeviceSignalRow): SignalStatusResult {
  return {
    id: row.clientEventId,
    outcome: row.outcome,
    ...(row.severity ? { severity: row.severity } : {}),
    ...(row.verdictId ? { verdictId: row.verdictId } : {}),
    alerted: row.alertId !== null,
  };
}

export async function signalStatus(
  session: NeoSession,
  deviceId: string,
  idsParam: string | null,
  now = new Date(),
): Promise<Outcome<SignalStatusResponse>> {
  const slot = takeRateSlot("signals-status", deviceId, SIGNAL_STATUS_LIMIT.limit, SIGNAL_STATUS_LIMIT.windowMs, now.getTime());
  if (!slot.ok) return rateLimited(slot.retryAfterSeconds);

  const ids = parseIds(idsParam);
  if (!ids) return fail(400, "bad_request", `Expected "ids" to be 1 to ${MAX_IDS} comma-separated uuids.`);

  const rows = await listDeviceSignalsByClientIds(session.tenantId, deviceId, ids);
  const byId = new Map(rows.map((r) => [r.clientEventId, r]));
  // Preserve the caller's order; unknown ids (another device's, or never seen) are omitted.
  const results = ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [toResult(row)] : [];
  });
  return { ok: true, value: { results } };
}
