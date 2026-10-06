/** Injectable dependencies for the Outlook connector, and the production/mock wiring (`getOutlookDeps`). */
import { logger } from "@neo/core";
import { analyzeEmail, type EmailAnalysis } from "@neo/tools";
import { env, inboundEnv, outlookEnv, type EnvSource } from "@/lib/env";
import { sharedUrlCache } from "../agent-run";
import { alertMailboxForwarding } from "../alerts";
import { finalizeSigninVerdict, persistSigninEvent } from "../signin/service";
import { saveVerdict } from "../verdicts";
import { createGraphClient } from "./graph";
import { createMockGraphClient } from "./graph-mock";
import { createMicrosoftOAuthClient, createMockOAuthClient, type OutlookOAuthClient } from "./oauth";
import { getOutlookStore, type OutlookStore } from "./store";
import type { OutlookGraphClient } from "./types";

export interface OutlookDeps {
  store: OutlookStore;
  oauth: OutlookOAuthClient;
  graphFor(accessToken: string): OutlookGraphClient;
  now(): Date;
  source: EnvSource;
  /** The connector always passes `maxUrls: 0`: mail links are parsed, never fetched. */
  analyzeEmail(input: { raw: string }, opts: { maxUrls: number }): Promise<EmailAnalysis>;
  finalizeSignin: typeof finalizeSigninVerdict;
  persistSignin: typeof persistSigninEvent;
  saveVerdict: typeof saveVerdict;
  alertForwarding: typeof alertMailboxForwarding;
}

/** The connector wiring for this environment, or null when the feature is off. */
export function getOutlookDeps(source: EnvSource = process.env): OutlookDeps | null {
  const o = outlookEnv(source);
  if (o.mode === "off") return null;
  const common = {
    store: getOutlookStore(),
    now: () => new Date(),
    source,
    // Same URL reputation cache as the chat tools; MOCK_MODE analyzers are fixtures.
    analyzeEmail: (input: { raw: string }, opts: { maxUrls: number }) => analyzeEmail(input, { ...opts, deps: { cache: sharedUrlCache() } }),
    finalizeSignin: finalizeSigninVerdict,
    persistSignin: persistSigninEvent,
    saveVerdict,
    alertForwarding: alertMailboxForwarding,
  };
  if (o.mode === "mock") {
    const redirect = o.OUTLOOK_REDIRECT_URI ?? `${inboundEnv(source).APP_URL}/api/connectors/outlook/callback`;
    const graph = createMockGraphClient();
    return { ...common, oauth: createMockOAuthClient(redirect), graphFor: () => graph };
  }
  if (env().MOCK_MODE) logger.warn("MOCK_MODE is set on a deployed environment; the Outlook connector uses the real Microsoft endpoints", "outlook");
  return {
    ...common,
    oauth: createMicrosoftOAuthClient({ clientId: o.OUTLOOK_CLIENT_ID!, clientSecret: o.OUTLOOK_CLIENT_SECRET!, redirectUri: o.OUTLOOK_REDIRECT_URI! }),
    graphFor: (accessToken) => createGraphClient({ accessToken }),
  };
}
