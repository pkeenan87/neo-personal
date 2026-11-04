/** Production wiring for the inbound jobs (tests build their own deps). */
import { logger, runTriage } from "@neo/core";
import { SCHEDULE_RUN_RETENTION_DAYS, previewRetention, pruneScheduleRuns, purgeOldAlerts, purgeOldHouseholdRecords, weeklyDigest, type RetentionPreview } from "@neo/db";
import { analyzeEmail, EMAIL_ANALYSIS_GUIDANCE } from "@neo/tools";
import { inboundEnv } from "@/lib/env";
import { sharedUrlCache } from "../agent-run";
import { recordAudit } from "../audit";
import { expireDueChildRequests } from "../child-requests";
import { getDb } from "../db";
import { purgeOldDevices } from "../devices";
import { purgeExpiredMemory } from "../household-memory";
import { getMailer, getReceivedMailClient } from "../email/resend";
import { purgeExpiredReputationCache, purgeOldDeviceSignals } from "../signals/store";
import { checkCaps, noteCapHit, recordUsage } from "../usage";
import type { ExpireDeps } from "./artifacts-expire-job";
import type { EmailJobDeps } from "./email-received-job";
import { inboundRepo } from "./repo";

export function createEmailJobDeps(): EmailJobDeps {
  const repo = inboundRepo();
  return {
    mail: getReceivedMailClient(),
    artifacts: repo.artifacts,
    mailer: getMailer(),
    listMembers: repo.listMembers,
    updateMessage: repo.updateMessage,
    findMessage: repo.findMessage,
    checkCaps,
    noteCapHit: async (tenantId, userId, caps) => {
      if (caps.reason) await noteCapHit(tenantId, userId, caps, caps.reason);
    },
    recordUsage,
    // Same URL reputation cache as the chat tools.
    analyzeEmail: (input, opts) => analyzeEmail(input, { ...opts, deps: { cache: sharedUrlCache() } }),
    runTriage,
    triageGuidance: EMAIL_ANALYSIS_GUIDANCE,
    saveVerdict: repo.saveVerdict,
    audit: recordAudit,
    appUrl: inboundEnv().APP_URL,
  };
}

export function createExpireDeps(): ExpireDeps {
  const repo = inboundRepo();
  const db = getDb();
  return {
    artifacts: repo.artifacts,
    purgeOldInbound: repo.purgeOld,
    // Without a database, in-memory alerts are bounded and die with the process.
    purgeOldAlerts: async () => (db ? purgeOldAlerts(db) : 0),
    purgeOldDevices,
    purgeOldDeviceSignals,
    purgeExpiredReputationCache,
    purgeWeeklyDigestPayloads: async () => db ? weeklyDigest.purgeStalePayloads(db) : 0,
    expireChildRequests: () => expireDueChildRequests(),
    // The job log is new (migration 0025): a database that has not run it yet must not break retention.
    pruneScheduleRuns: async () => {
      if (!db) return 0;
      try {
        return await pruneScheduleRuns(db, SCHEDULE_RUN_RETENTION_DAYS);
      } catch (err) {
        logger.warn("Schedule run pruning failed", "retention", { errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
        return 0;
      }
    },
    // Household memory is new (migration 0028): a database that has not run it yet must not break retention.
    purgeExpiredMemory: async () => {
      if (!db) return 0;
      try {
        return await purgeExpiredMemory();
      } catch (err) {
        logger.warn("Household memory purge failed", "retention", { errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
        return 0;
      }
    },
    // The household-records purge is new (migration 0031): a database that has not run it yet must not break retention.
    purgeOldHouseholdRecords: async () => {
      if (!db) return 0;
      try {
        const r = await purgeOldHouseholdRecords(db);
        logger.info("Household records purged", "retention", { ...r });
        return r.outbox + r.invites + r.deviceCommands + r.eveSessions + r.usageEvents;
      } catch (err) {
        logger.warn("Household records purge failed", "retention", { errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
        return 0;
      }
    },
  };
}

/** The read-only side of the retention job: what it would purge. Never deletes (the shadow run uses only this). */
export function createExpireReadPorts(): {
  listExpiredArtifacts(limit: number): Promise<Array<{ id: string; tenantId: string }>>;
  /** Rows the household-data purges would delete now, honouring each household's retention settings; null without a database. */
  previewPurges?: () => Promise<RetentionPreview | null>;
} {
  const repo = inboundRepo();
  const db = getDb();
  return {
    previewPurges: async () => {
      if (!db) return null;
      // Migration 0030: a database that has not run it yet must not break retention.
      try {
        return await previewRetention(db);
      } catch (err) {
        logger.warn("Retention preview failed", "retention", { errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
        return null;
      }
    },
    listExpiredArtifacts: async (limit) => (repo.artifacts ? (await repo.artifacts.listExpired(limit)).map((a) => ({ id: a.id, tenantId: a.tenantId })) : []),
  };
}
