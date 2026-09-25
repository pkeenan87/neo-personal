/**
 * `artifacts-expire` (cron `0 4 * * *`): purge artifacts past their retention
 * and delete rejected/failed inbound rows older than 90 days.
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
}

export async function runArtifactsExpire(
  deps: ExpireDeps,
  step: StepRunner = inlineSteps,
): Promise<{ artifactsPurged: number; artifactErrors: number; inboundRowsDeleted: number }> {
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
  const result = { artifactsPurged: artifacts.purged, artifactErrors: artifacts.errors, inboundRowsDeleted };
  logger.info("Retention run finished", "retention", result);
  return result;
}
