/**
 * `artifacts-expire` (cron `0 4 * * *`): purge artifacts past their retention,
 * delete rejected/failed inbound rows older than 90 days, and delete old owner
 * alerts (acknowledged > 90 days, any > 180 days; _specs/owner-alerts.md), old devices
 * and enrollment codes (revoked devices > 90 days, spent codes > 30 days; _specs/device-enrollment.md),
 * device_signals rows older than 30 days, expired reputation_cache rows, and expired encrypted weekly-digest payloads.
 * It also expires child requests past the end of the child's day and resolves their alerts (_specs/v2-m2-child.md section 8).
 */
import { logger } from "@neo/core";
import type { ArtifactStore } from "@neo/db";
import type { StepRunner } from "./email-received-job";
import { inlineSteps } from "./email-received-job";

export const ARTIFACT_BATCH = 200;
export const INBOUND_ROW_RETENTION_DAYS = 90;

export interface ExpireDeps {
  artifacts: ArtifactStore | null;
  /** Delete rejected/failed inbound rows older than this many days, across tenants. */
  purgeOldInbound(olderThanDays: number): Promise<number>;
  /** Delete old owner alerts across tenants; returns the count. */
  purgeOldAlerts(): Promise<number>;
  /** Delete long-revoked devices and spent enrollment codes across tenants; returns the count. */
  purgeOldDevices(): Promise<number>;
  /** Delete device_signals rows older than 30 days (received_at), across tenants; returns the count. */
  purgeOldDeviceSignals(): Promise<number>;
  /** Delete expired reputation_cache rows, across households; returns the count. */
  purgeExpiredReputationCache(): Promise<number>;
  /** Clear non-sending digest payloads and sending payloads older than 24 hours; returns the count. */
  purgeWeeklyDigestPayloads(): Promise<number>;
  /** Mark pending child requests past their expiry `expired` and resolve their alerts, across households; returns the count. */
  expireChildRequests?(): Promise<number>;
}

export async function runArtifactsExpire(
  deps: ExpireDeps,
  step: StepRunner = inlineSteps,
): Promise<{
  artifactsPurged: number;
  artifactErrors: number;
  inboundRowsDeleted: number;
  alertsDeleted: number;
  devicesDeleted: number;
  signalsDeleted: number;
  reputationCacheDeleted: number;
  digestPayloadsDeleted: number;
  /** Present when the run expires child requests. */
  childRequestsExpired?: number;
}> {
  const artifacts = await step.run("purge-artifacts", async () => {
    if (!deps.artifacts) return { purged: 0, errors: 0 };
    const expired = await deps.artifacts.listExpired(ARTIFACT_BATCH);
    let purged = 0;
    let errors = 0;
    for (const a of expired) {
      try {
        // The app role must pass the tenant from listExpired() (RLS).
        await deps.artifacts.purge(a.id, a.tenantId);
        purged++;
      } catch (err) {
        errors++;
        logger.error("Artifact purge failed", "retention", {
          artifactId: a.id,
          tenantId: a.tenantId,
          errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 300),
        });
      }
    }
    return { purged, errors };
  });
  const inboundRowsDeleted = await step.run("purge-inbound-rows", () => deps.purgeOldInbound(INBOUND_ROW_RETENTION_DAYS));
  const alertsDeleted = await step.run("purge-alerts", () => deps.purgeOldAlerts());
  const devicesDeleted = await step.run("purge-devices", () => deps.purgeOldDevices());
  const signalsDeleted = await step.run("purge-signals", () => deps.purgeOldDeviceSignals());
  const reputationCacheDeleted = await step.run("purge-reputation-cache", () => deps.purgeExpiredReputationCache());
  const digestPayloadsDeleted = await step.run("purge-digest-payloads", () => deps.purgeWeeklyDigestPayloads());
  const childRequestsExpired = deps.expireChildRequests ? await step.run("expire-child-requests", () => deps.expireChildRequests!()) : undefined;
  const result = {
    artifactsPurged: artifacts.purged,
    artifactErrors: artifacts.errors,
    inboundRowsDeleted,
    alertsDeleted,
    devicesDeleted,
    signalsDeleted,
    reputationCacheDeleted,
    digestPayloadsDeleted,
    ...(childRequestsExpired !== undefined ? { childRequestsExpired } : {}),
  };
  logger.info("Retention run finished", "retention", result);
  return result;
}
