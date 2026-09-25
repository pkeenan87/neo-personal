/** Production wiring for the inbound jobs (tests build their own deps). */
import { inboundEnv } from "@/lib/env";
import { recordAudit } from "../audit";
import { getMailer, getReceivedMailClient } from "../email/resend";
import { analyzeEmail, EMAIL_ANALYSIS_GUIDANCE, runTriage } from "../phase1-stubs-inbound";
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
    analyzeEmail,
    runTriage,
    triageGuidance: EMAIL_ANALYSIS_GUIDANCE,
    saveVerdict: repo.saveVerdict,
    audit: recordAudit,
    appUrl: inboundEnv().APP_URL,
  };
}

export function createExpireDeps(): ExpireDeps {
  const repo = inboundRepo();
  return { artifacts: repo.artifacts, purgeOldInbound: repo.purgeOld };
}
