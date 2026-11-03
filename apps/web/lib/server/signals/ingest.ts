/**
 * POST /api/signals ingest (_specs/signals.md "Ingest"): validate, rate-limit, deduplicate,
 * evaluate the member's policy (the @neo/core engine), and apply the result (verdict
 * + alert, or queue an escalation) per event, in order. One bad event never fails the batch.
 */
import { evaluateSignal, type Decision } from "@neo/core";
import { findRemoteAccessTool, normalizeUrl } from "@neo/tools";
import { MAX_SIGNAL_BATCH, parseSignalEvent, type SignalEvent } from "@neo/verdict";
import type { SignalIngestResponse, SignalRejectReason, SignalResult } from "@/lib/signal-types";
import type { DeviceSession } from "@/lib/session";
import { recordAudit } from "../audit";
import { getDevice } from "../devices";
import type { Outcome } from "../household";
import { takeRateSlot } from "../rate-limit";
import type { SignalAlertKind } from "../alerts";
import { applyAlertedSignal, type SignalDeviceInfo } from "./apply";
import { queueSignalEscalate } from "./escalate";
import { loadSignalProtection, toRecentSignals } from "./protection";
import { ENGINE_CATALOG } from "./rules";
import { countDeviceSignalsSince, insertDeviceSignal, listExpectedTools, listRecentMemberSignals, updateDeviceSignal } from "./store";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const STALE_MS = 24 * HOUR_MS;
const FUTURE_CLAMP_MS = 5 * 60 * 1000;
const DAILY_EVENT_CAP = 500;
const DAILY_ESCALATION_CAP = 50;
/** How far back to look for `warning_bypassed`'s `relatesTo` and for scam-in-progress correlation. */
const RELATES_TO_WINDOW_MS = DAY_MS;

export const SIGNAL_INGEST_LIMIT = { limit: 60, windowMs: HOUR_MS } as const;

function fail(status: number, code: string, message: string): Outcome<never> {
  return { ok: false, status, code, message };
}

function rateLimited(retryAfterSeconds: number): Outcome<never> {
  return { ok: false, status: 429, code: "rate_limited", message: "Too many requests. Please try again later.", retryAfterSeconds };
}

function dayStartOf(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Built-in macOS tool (docs/contracts.md "Desktop agent, macOS"): agents report sessions for it, never installs. */
const BUILT_IN_TOOL_ID = "apple_screen_sharing";

function eventToolId(event: SignalEvent): string | undefined {
  return event.detector === "remote_tool_download" || event.detector === "remote_access_tool" || event.detector === "remote_access_session" ? event.toolId : undefined;
}

/** The domain, toolId or app/program name the event is about (device_signals.subject, ≤ 253 chars). */
function subjectOf(event: SignalEvent): string {
  switch (event.detector) {
    case "tech_support_scam":
    case "lookalike_login":
    case "dangerous_site":
    case "remote_tool_download":
    case "warning_bypassed":
    case "payment_page":
    case "web_blocked":
      return event.domain;
    case "remote_access_tool":
    case "remote_access_session":
      return event.toolId;
    case "unwanted_software":
    case "app_installed":
    case "app_blocked":
      return event.name;
    case "tcc_grant":
      return event.app;
    case "screen_time_exhausted":
      return "screen_time";
    case "tamper_detected":
      return event.reason;
    default: {
      const _exhaustive: never = event;
      return (_exhaustive as SignalEvent).detector;
    }
  }
}

/** The validated event minus id/type/detector (docs/contracts.md `device_signals.payload`). */
function payloadOf(event: SignalEvent): Record<string, unknown> {
  const { id: _id, type: _type, detector: _detector, ...rest } = event;
  return rest;
}

/** `domain` re-normalized on the server: must equal its own registrable domain (IPs accepted as themselves). */
function isRegistrableDomain(domain: string): boolean {
  try {
    const norm = normalizeUrl(domain);
    return norm.is_ip || (Boolean(norm.registrable) && norm.host === norm.registrable);
  } catch {
    return false;
  }
}

/**
 * Ingest one batch of signal events for `deviceId` (_specs/signals.md "Ingest"). 60
 * requests/hour/device (429); body must be `{ events: 1..50 }` (400 `bad_request`); every
 * event gets its own result, in order, and one bad event never fails the batch.
 */
export async function ingestSignals(session: DeviceSession, deviceId: string, body: Record<string, unknown> | null, now = new Date()): Promise<Outcome<SignalIngestResponse>> {
  const slot = takeRateSlot("signals-ingest", deviceId, SIGNAL_INGEST_LIMIT.limit, SIGNAL_INGEST_LIMIT.windowMs, now.getTime());
  if (!slot.ok) return rateLimited(slot.retryAfterSeconds);

  const rawEvents = body?.events;
  if (!Array.isArray(rawEvents) || rawEvents.length < 1 || rawEvents.length > MAX_SIGNAL_BATCH) {
    return fail(400, "bad_request", `Expected { "events": array of 1 to ${MAX_SIGNAL_BATCH} }.`);
  }

  const device = await getDevice(session.tenantId, deviceId);
  if (!device || device.revokedAt) return fail(401, "unauthenticated", "This device is no longer connected to a household.");
  // The device's member is the subject of everything it reports (never the token holder's user or role).
  if (!device.memberId) return fail(401, "unauthenticated", "This device is no longer connected to a household.");
  const protectedMember = { memberId: device.memberId, userId: device.userId };
  const deviceInfo: SignalDeviceInfo = { id: device.id, tenantId: session.tenantId, ...protectedMember, name: device.name, memberName: device.memberName };

  const expectedTools = await listExpectedTools(session.tenantId, { deviceId });
  const { policy, memberId } = await loadSignalProtection(session.tenantId, protectedMember, deviceId);
  const dayStart = dayStartOf(now);
  const results: SignalResult[] = [];

  for (const raw of rawEvents) {
    const parsed = parseSignalEvent(raw);
    if (!parsed.ok) {
      results.push({ id: parsed.id, status: "rejected", reason: "invalid" });
      continue;
    }
    const event = parsed.event;
    const rejected = (reason: SignalRejectReason): SignalResult => ({ id: event.id, status: "rejected", reason });

    if ("domain" in event && !isRegistrableDomain(event.domain)) {
      results.push(rejected("invalid"));
      continue;
    }
    const toolId = eventToolId(event);
    if (toolId !== undefined && !findRemoteAccessTool(toolId)) {
      results.push(rejected("unknown_tool"));
      continue;
    }
    // Apple Screen Sharing is built into macOS: only its sessions are reported, never an install or download.
    if (toolId === BUILT_IN_TOOL_ID && event.detector !== "remote_access_session") {
      results.push(rejected("invalid"));
      continue;
    }

    const observedAtRaw = new Date(event.observedAt);
    if (Number.isNaN(observedAtRaw.getTime())) {
      results.push(rejected("invalid"));
      continue;
    }
    if (now.getTime() - observedAtRaw.getTime() > STALE_MS) {
      results.push(rejected("stale"));
      continue;
    }
    const observedAt = observedAtRaw.getTime() > now.getTime() + FUTURE_CLAMP_MS ? now : observedAtRaw;

    const acceptedToday = await countDeviceSignalsSince(session.tenantId, deviceId, dayStart);
    if (acceptedToday >= DAILY_EVENT_CAP) {
      results.push(rejected("rate_limited"));
      const flood = takeRateSlot("signals-flood", deviceId, 1, DAY_MS, now.getTime());
      if (flood.ok) await recordAudit(session.tenantId, null, "signals.flood", { deviceId });
      continue;
    }

    const recentRows = await listRecentMemberSignals(session.tenantId, protectedMember.memberId, { since: new Date(now.getTime() - RELATES_TO_WINDOW_MS) });
    const evaluate = (signalId?: string): Decision =>
      evaluateSignal(policy, { event, ...(signalId ? { signalId } : {}) }, { now, deviceId, expectedTools, recent: toRecentSignals(recentRows), catalog: ENGINE_CATALOG });
    const decision = evaluate();

    const escalatedToday = decision.escalate ? await countDeviceSignalsSince(session.tenantId, deviceId, dayStart, { escalatedOnly: true }) : 0;
    const willEscalate = decision.escalate && escalatedToday < DAILY_ESCALATION_CAP;

    const subject = subjectOf(event);
    const { row, duplicate } = await insertDeviceSignal({
      tenantId: session.tenantId,
      deviceId,
      memberId: protectedMember.memberId,
      userId: device.userId,
      clientEventId: event.id,
      type: event.type,
      detector: event.detector,
      subject,
      payload: payloadOf(event),
      observedAt,
      escalated: willEscalate,
      now,
    });
    if (duplicate) {
      results.push({ id: event.id, status: "duplicate" });
      continue;
    }

    if (decision.action === "reject") {
      await updateDeviceSignal(session.tenantId, row.id, { outcome: "dismissed" });
      results.push(rejected(decision.rejectReason ?? "relates_to_unknown"));
      continue;
    }
    if (decision.action === "record" || decision.action === "dismiss") {
      await updateDeviceSignal(session.tenantId, row.id, { outcome: decision.action === "record" ? "recorded" : "dismissed" });
      results.push({ id: event.id, status: "accepted" });
      continue;
    }
    if (decision.action === "escalate") {
      if (!willEscalate) {
        await updateDeviceSignal(session.tenantId, row.id, { outcome: "dismissed" });
        results.push({ id: event.id, status: "accepted" });
        continue;
      }
      results.push({ id: event.id, status: "accepted", pending: true });
      await queueSignalEscalate({ signalId: row.id, tenantId: session.tenantId });
      continue;
    }

    // "incident": re-evaluate with the stored row id so correlated alerts reference real rows.
    const final = evaluate(row.id);
    const applied = await applyAlertedSignal({
      device: deviceInfo,
      event,
      rowId: row.id,
      subject,
      severity: final.severity!,
      verdictLabel: final.verdictLabel,
      alertKind: final.kind as SignalAlertKind,
      reasonCodes: final.reasonCodes,
      ...(final.bypassOf ? { bypassOf: { relatesTo: final.bypassOf.relatesTo, relatedVerdictId: final.bypassOf.relatedVerdictId } } : {}),
      memberId,
      correlations: final.correlations,
      now,
    });
    results.push({ id: event.id, status: "accepted", severity: final.severity!, ...(applied.verdictId ? { verdictId: applied.verdictId } : {}) });
  }

  return { ok: true, value: { results } };
}
