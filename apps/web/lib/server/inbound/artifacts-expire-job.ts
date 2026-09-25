/**
 * `artifacts-expire` (cron `0 4 * * *`): purge artifacts past their retention
 * and delete rejected/failed inbound rows older than 90 days.
 */
import { logger } from "@neo/core";
import type { ArtifactStore } from "../phase1-stubs-inbound";
import type { StepRunner } from "./email-received-job";
import { inlineSteps } from "./email-received-job";

export const ARTIFACT_BATCH = 200;
export const INBOUND_ROW_RETENTION_DAYS = 90;

export interface ExpireDeps {
  artifacts: ArtifactStore | null;
  purgeOldInbound(before: Date): Promise<number>;
  now?: () => Date;
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
        await deps.artifacts.purge(a.id);
        purged++;
      } catch (err) {
        errors++;
        logger.error("Artifact purge failed", "retention", {
          artifactId: a.id,
          errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 300),
        });
      }
    }
    return { purged, errors };
  });
  const inboundRowsDeleted = await step.run("purge-inbound-rows", async () => {
    const now = deps.now ? deps.now() : new Date();
    return deps.purgeOldInbound(new Date(now.getTime() - INBOUND_ROW_RETENTION_DAYS * 86_400_000));
  });
  const result = { artifactsPurged: artifacts.purged, artifactErrors: artifacts.errors, inboundRowsDeleted };
  // Counts go in the message: logger metadata is allowlisted (SAFE_METADATA_FIELDS) and drops unknown keys.
  logger.info(
    `Retention run finished: ${result.artifactsPurged} artifacts purged, ${result.artifactErrors} errors, ${result.inboundRowsDeleted} inbound rows deleted`,
    "retention",
  );
  return result;
}
