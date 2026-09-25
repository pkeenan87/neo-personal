/** `artifacts-expire`: daily retention (cron 0 4 * * *, UTC). */
import { runArtifactsExpire } from "@/lib/server/inbound/artifacts-expire-job";
import { createExpireDeps } from "@/lib/server/inbound/deps";
import type { StepRunner } from "@/lib/server/inbound/email-received-job";
import { inngest } from "../client";

export const artifactsExpire = inngest.createFunction(
  { id: "artifacts-expire", name: "Purge expired artifacts", triggers: [{ cron: "0 4 * * *" }], retries: 2 },
  async ({ step }) => {
    const steps: StepRunner = {
      run: <T>(name: string, fn: () => Promise<T>) => step.run(name, fn) as unknown as Promise<T>,
    };
    return runArtifactsExpire(createExpireDeps(), steps);
  },
);
