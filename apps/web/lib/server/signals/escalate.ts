/**
 * Signal escalations (_specs/signals.md "Escalations"): the network-dependent half of the
 * rules table (`lookalike_login`, `dangerous_site`, `unwanted_software` `unsigned_unknown`).
 * Runs in the `signal-escalate` Inngest function (inngest/functions/signal-escalate.ts),
 * or inline in MOCK_MODE without INNGEST_EVENT_KEY (`queueSignalEscalate`, mirroring
 * lib/server/alerts `queueDelivery`). A failed or inconclusive lookup always leaves the signal
 * `dismissed` and never raises an alert — escalation failures fail open, same as everything
 * else in this feature.
 */
import { logger } from "@neo/core";
import type { DevicePublic } from "@neo/db";
import {
  analyzeUrl,
  checkSafeBrowsing,
  checkVirusTotalFile,
  isSkipped,
  resolveDeps,
  type CheckContext,
  type ReputationCache,
  type SafeBrowsingResult,
  type Skipped,
} from "@neo/tools";
import type { FileVirusTotalResult, AttachmentSkip } from "@neo/tools";
import type { SignalEvent } from "@neo/verdict";
import { inngest } from "@/inngest/client";
import { env, inboundEnv } from "@/lib/env";
import { sharedUrlCache } from "../agent-run";
import type { SignalAlertKind } from "../alerts";
import { getDevice } from "../devices";
import { applyAlertedSignal, type SignalDeviceInfo } from "./apply";
import { classifyUrlAnalysis } from "./classify";
import { alertKindForDetector } from "./rules";
import { getDeviceSignal, listExpectedTools, updateDeviceSignal } from "./store";

export const SIGNAL_ESCALATE_EVENT = "neo/signal.escalate";
const ESCALATION_TTL_SECONDS = 24 * 60 * 60;

export interface SignalEscalateData {
  signalId: string;
  tenantId: string;
}

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

export interface EscalateDeps {
  getSignal(tenantId: string, id: string): ReturnType<typeof getDeviceSignal>;
  getDevice(tenantId: string, deviceId: string): Promise<DevicePublic | undefined>;
  getExpectedTools(tenantId: string, deviceId: string): ReturnType<typeof listExpectedTools>;
  cache: ReputationCache;
  analyzeUrl: typeof analyzeUrl;
  checkSafeBrowsing: typeof checkSafeBrowsing;
  checkVirusTotalFile: typeof checkVirusTotalFile;
  checkContext(): CheckContext;
  now(): Date;
}

export function createEscalateDeps(): EscalateDeps {
  return {
    getSignal: (tenantId, id) => getDeviceSignal(tenantId, id),
    getDevice: (tenantId, deviceId) => getDevice(tenantId, deviceId),
    getExpectedTools: (tenantId, deviceId) => listExpectedTools(tenantId, { deviceId }),
    cache: sharedUrlCache(),
    analyzeUrl,
    checkSafeBrowsing,
    checkVirusTotalFile,
    checkContext: () => ({ deps: resolveDeps({ cache: sharedUrlCache() }) }),
    now: () => new Date(),
  };
}

/** Send `neo/signal.escalate`; runs inline (awaited) in MOCK_MODE without INNGEST_EVENT_KEY, like alert delivery. */
export async function queueSignalEscalate(data: SignalEscalateData, deps: EscalateDeps = createEscalateDeps()): Promise<void> {
  const e = env();
  const ie = inboundEnv();
  if (e.MOCK_MODE && !ie.INNGEST_EVENT_KEY) {
    await runSignalEscalate(data, deps).catch((err) => logger.error("Inline signal escalation failed", "signals", { tenantId: data.tenantId, errorMessage: errText(err) }));
    return;
  }
  try {
    await inngest.send({ name: SIGNAL_ESCALATE_EVENT, data });
  } catch (err) {
    // The row stays `pending`; a later retry of the batch (or a manual re-run) picks it up.
    logger.error("Inngest send failed for signal escalation", "signals", { tenantId: data.tenantId, errorMessage: errText(err) });
  }
}

const g = globalThis as typeof globalThis & { __neoSafeBrowsingUnconfiguredLogged?: boolean };

async function cachedSafeBrowsing(domain: string, deps: EscalateDeps): Promise<SafeBrowsingResult | Skipped> {
  const key = `neo:signal-escalation:v1:domain:${domain}`;
  const hit = (await deps.cache.get(key)) as SafeBrowsingResult | undefined;
  if (hit) return hit;
  const result = await deps.checkSafeBrowsing([`https://${domain}/`], deps.checkContext());
  if (isSkipped(result)) {
    if (result.skipped === "no_api_key" && !g.__neoSafeBrowsingUnconfiguredLogged) {
      g.__neoSafeBrowsingUnconfiguredLogged = true;
      logger.warn("GOOGLE_SAFE_BROWSING_API_KEY is unset; dangerous_site signal escalations are dismissed", "signals");
    }
    return result;
  }
  await deps.cache.set(key, result, ESCALATION_TTL_SECONDS);
  return result;
}

async function cachedVirusTotalFile(sha256: string, deps: EscalateDeps): Promise<FileVirusTotalResult | AttachmentSkip> {
  const key = `neo:signal-escalation:v1:hash:${sha256}`;
  const hit = (await deps.cache.get(key)) as FileVirusTotalResult | undefined;
  if (hit) return hit;
  const result = await deps.checkVirusTotalFile(sha256, deps.checkContext());
  if (!isSkipped(result)) await deps.cache.set(key, result, ESCALATION_TTL_SECONDS);
  return result;
}

/** Rebuild the validated `SignalEvent` this row was stored from (payload = the event minus id/type/detector). */
function reconstructEvent(row: { clientEventId: string; type: string; detector: string; payload: Record<string, unknown> }): SignalEvent {
  return { id: row.clientEventId, type: row.type, detector: row.detector, ...row.payload } as unknown as SignalEvent;
}

async function dismiss(tenantId: string, rowId: string): Promise<void> {
  await updateDeviceSignal(tenantId, rowId, { outcome: "dismissed" });
}

/** Evaluate one pending escalation and apply the result (verdict + alert, or a quiet dismissal). Never throws. */
export async function runSignalEscalate(data: SignalEscalateData, deps: EscalateDeps = createEscalateDeps()): Promise<void> {
  try {
    const row = await deps.getSignal(data.tenantId, data.signalId);
    if (!row || row.outcome !== "pending") return; // missing, or already resolved (idempotent retry)

    const device = await deps.getDevice(data.tenantId, row.deviceId);
    if (!device || device.revokedAt) {
      await dismiss(data.tenantId, row.id);
      return;
    }
    const event = reconstructEvent(row);
    const deviceInfo: SignalDeviceInfo = { id: device.id, tenantId: data.tenantId, userId: device.userId, name: device.name, memberName: device.memberName };

    if (event.detector === "lookalike_login") {
      await escalateLookalikeLogin(event, row.id, row.subject, deviceInfo, deps);
    } else if (event.detector === "dangerous_site") {
      await escalateDangerousSite(event, row.id, row.subject, deviceInfo, deps);
    } else if (event.detector === "unwanted_software" && event.reason === "unsigned_unknown" && event.sha256) {
      await escalateUnwantedSoftware(event, row.id, row.subject, deviceInfo, event.sha256, deps);
    } else {
      // Not an escalating detector (defensive: should never be queued as anything else).
      await dismiss(data.tenantId, row.id);
    }
  } catch (err) {
    logger.error("Signal escalation failed", "signals", { tenantId: data.tenantId, signalId: data.signalId, errorMessage: errText(err) });
    await dismiss(data.tenantId, data.signalId).catch(() => undefined);
  }
}

/**
 * lookalike_login escalation: analyze the domain and use the same `classifyUrlAnalysis`
 * mapping as the on-demand check (`_specs/browser-extension.md`). `dangerous` confirms
 * malicious (high severity); `suspicious` confirms suspicious (medium); anything else
 * (`unknown` or `no_known_problems`) dismisses without an alert, same as any other
 * inconclusive escalation.
 */
async function escalateLookalikeLogin(event: Extract<SignalEvent, { detector: "lookalike_login" }>, rowId: string, subject: string, device: SignalDeviceInfo, deps: EscalateDeps): Promise<void> {
  const analysis = await deps.analyzeUrl(`https://${event.domain}/`, { deps: { cache: deps.cache } });
  const { rating } = classifyUrlAnalysis(analysis);
  if (rating === "dangerous") {
    const codes = ["brand_lookalike", ...analysis.heuristics.filter((h) => h === "safe_browsing_match" || h === "virustotal_malicious" || h === "urlscan_malicious")];
    await applyAlertedSignal({ device, event, rowId, subject, severity: "high", verdictLabel: "malicious", alertKind: alertKindForDetector("lookalike_login") as SignalAlertKind, reasonCodes: codes });
    return;
  }
  if (rating === "suspicious") {
    const isYoung = analysis.heuristics.includes("young_domain");
    const codes = isYoung ? ["brand_lookalike_young_domain"] : ["brand_lookalike"];
    await applyAlertedSignal({ device, event, rowId, subject, severity: "medium", verdictLabel: "suspicious", alertKind: alertKindForDetector("lookalike_login") as SignalAlertKind, reasonCodes: codes });
    return;
  }
  await dismiss(device.tenantId, rowId);
}

async function escalateDangerousSite(event: Extract<SignalEvent, { detector: "dangerous_site" }>, rowId: string, subject: string, device: SignalDeviceInfo, deps: EscalateDeps): Promise<void> {
  const result = await cachedSafeBrowsing(event.domain, deps);
  if (isSkipped(result) || !result.flagged) {
    await dismiss(device.tenantId, rowId);
    return;
  }
  await applyAlertedSignal({
    device,
    event,
    rowId,
    subject,
    severity: "high",
    verdictLabel: "malicious",
    alertKind: alertKindForDetector("dangerous_site") as SignalAlertKind,
    reasonCodes: ["safe_browsing_prefix", "safe_browsing_match"],
  });
}

async function escalateUnwantedSoftware(
  event: Extract<SignalEvent, { detector: "unwanted_software" }>,
  rowId: string,
  subject: string,
  device: SignalDeviceInfo,
  sha256: string,
  deps: EscalateDeps,
): Promise<void> {
  const result = await cachedVirusTotalFile(sha256, deps);
  if (!("status" in result) || result.status !== "found" || result.malicious < 3) {
    await dismiss(device.tenantId, rowId);
    return;
  }
  await applyAlertedSignal({ device, event, rowId, subject, severity: "high", verdictLabel: "malicious", alertKind: alertKindForDetector("unwanted_software") as SignalAlertKind, reasonCodes: ["unsigned_unknown", "virustotal_malicious"] });
}
