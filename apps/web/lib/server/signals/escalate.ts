/**
 * Signal escalations (_specs/signals.md "Escalations"): the network-dependent half of the
 * rules table (`lookalike_login`, `dangerous_site`, `unwanted_software` `unsigned_unknown`).
 * Runs in the `signal-escalate` Inngest function (inngest/functions/signal-escalate.ts),
 * or inline in MOCK_MODE without INNGEST_EVENT_KEY (`queueSignalEscalate`, mirroring
 * lib/server/alerts `queueDelivery`). A failed or inconclusive lookup always leaves the signal
 * `dismissed` and never raises an alert — escalation failures fail open, same as everything
 * else in this feature.
 */
import { evaluateSignal, logger, type Enrichment } from "@neo/core";
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
import { loadSignalProtection, toRecentSignals } from "./protection";
import { ENGINE_CATALOG } from "./rules";
import { getDeviceSignal, listExpectedTools, listRecentUserSignals, updateDeviceSignal, type DeviceSignalRow } from "./store";

const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

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

    let enrichment: Enrichment | undefined;
    if (event.detector === "lookalike_login") {
      enrichment = await enrichLookalikeLogin(event, deps);
    } else if (event.detector === "dangerous_site") {
      enrichment = await enrichDangerousSite(event, deps);
    } else if (event.detector === "unwanted_software" && event.reason === "unsigned_unknown" && event.sha256) {
      enrichment = await enrichUnwantedSoftware(event.sha256, deps);
    }
    if (!enrichment) {
      // Not an escalating detector (defensive: should never be queued as anything else).
      await dismiss(data.tenantId, row.id);
      return;
    }
    await applyEnrichment(event, row, deviceInfo, enrichment, deps);
  } catch (err) {
    logger.error("Signal escalation failed", "signals", { tenantId: data.tenantId, signalId: data.signalId, errorMessage: errText(err) });
    await dismiss(data.tenantId, data.signalId).catch(() => undefined);
  }
}

/**
 * Run the policy engine on the lookup result and apply the decision through the same helper as
 * the synchronous path: an `incident` raises the verdict/alert (and any correlated alerts), anything
 * else (a clean, failed or inconclusive lookup) leaves the signal quietly `dismissed`.
 */
async function applyEnrichment(event: SignalEvent, row: DeviceSignalRow, device: SignalDeviceInfo, enrichment: Enrichment, deps: EscalateDeps): Promise<void> {
  const now = deps.now();
  const { policy, memberId } = await loadSignalProtection(device.tenantId, device.userId, device.id);
  const [expectedTools, recentRows] = await Promise.all([
    deps.getExpectedTools(device.tenantId, device.id),
    listRecentUserSignals(device.tenantId, device.userId, { since: new Date(now.getTime() - RECENT_WINDOW_MS) }),
  ]);
  const decision = evaluateSignal(policy, { event, signalId: row.id, enrichment }, { now, deviceId: device.id, expectedTools, recent: toRecentSignals(recentRows), catalog: ENGINE_CATALOG });
  if (decision.action !== "incident") {
    await dismiss(device.tenantId, row.id);
    return;
  }
  await applyAlertedSignal({
    device,
    event,
    rowId: row.id,
    subject: row.subject,
    severity: decision.severity!,
    verdictLabel: decision.verdictLabel,
    alertKind: decision.kind as SignalAlertKind,
    reasonCodes: decision.reasonCodes,
    memberId,
    correlations: decision.correlations,
    now,
  });
}

/**
 * lookalike_login lookup: analyze the domain and use the same `classifyUrlAnalysis`
 * mapping as the on-demand check (`_specs/browser-extension.md`). `dangerous` confirms
 * malicious (high severity); `suspicious` confirms suspicious (medium); anything else
 * (`unknown` or `no_known_problems`) is clean, same as any other inconclusive escalation.
 */
async function enrichLookalikeLogin(event: Extract<SignalEvent, { detector: "lookalike_login" }>, deps: EscalateDeps): Promise<Enrichment> {
  const analysis = await deps.analyzeUrl(`https://${event.domain}/`, { deps: { cache: deps.cache } });
  const { rating } = classifyUrlAnalysis(analysis);
  if (rating === "dangerous") {
    const codes = ["brand_lookalike", ...analysis.heuristics.filter((h) => h === "safe_browsing_match" || h === "virustotal_malicious" || h === "urlscan_malicious")];
    return { label: "malicious", severity: "high", reasonCodes: codes };
  }
  if (rating === "suspicious") {
    const isYoung = analysis.heuristics.includes("young_domain");
    return { label: "suspicious", severity: "medium", reasonCodes: isYoung ? ["brand_lookalike_young_domain"] : ["brand_lookalike"] };
  }
  return { label: "clean" };
}

async function enrichDangerousSite(event: Extract<SignalEvent, { detector: "dangerous_site" }>, deps: EscalateDeps): Promise<Enrichment> {
  const result = await cachedSafeBrowsing(event.domain, deps);
  if (isSkipped(result)) return { label: "failed" };
  if (!result.flagged) return { label: "clean" };
  return { label: "malicious", severity: "high", reasonCodes: ["safe_browsing_prefix", "safe_browsing_match"] };
}

async function enrichUnwantedSoftware(sha256: string, deps: EscalateDeps): Promise<Enrichment> {
  const result = await cachedVirusTotalFile(sha256, deps);
  if (!("status" in result) || result.status !== "found") return { label: "failed" };
  if (result.malicious < 3) return { label: "clean" };
  return { label: "malicious", severity: "high", reasonCodes: ["unsigned_unknown", "virustotal_malicious"] };
}
